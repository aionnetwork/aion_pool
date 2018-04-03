const fs = require('fs');
const redis = require('redis');
const async = require('async');
const stratum_pool = require('stratum-pool');
const util = require('stratum-pool/lib/util.js');
const RewardLogger = require('./logging/rewardLogger');

module.exports = function (logger) {

    const minersRewardLogger = new RewardLogger('logs/miners_rewards.log');
    const poolConfigs = JSON.parse(process.env.pools);
    let enabledPools = [];
    Object.keys(poolConfigs).forEach((coin) => {
        let poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing && poolOptions.paymentProcessing.enabled)
            enabledPools.push(coin)
    });

    async.filter(enabledPools, function (coin, callback) {
        SetupForPool(logger, minersRewardLogger, poolConfigs[coin], function (setupResults) {
            callback(setupResults);
        });
    }, function (coins) {
        // coins.forEach(function (coin) {
        //
        //     let poolOptions = poolConfigs[coin];
        //     let processingConfig = poolOptions.paymentProcessing;
        //     let logSystem = 'Payments';
        //     let logComponent = coin;
        //
        //     logger.debug(logSystem, logComponent, 'Payment processing setup to run every '
        //         + processingConfig.paymentInterval + ' second(s) with daemon ('
        //         + processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port
        //         + ') and redis (' + poolOptions.redis.host + ':' + poolOptions.redis.port + ')');
        //
        // });
    });
};


function SetupForPool(logger, minersRewardLogger, poolOptions, setupFinished) {


    let coin = poolOptions.coin.name;
    let processingConfig = poolOptions.paymentProcessing;

    let logSystem = 'Payments';
    let logComponent = coin;

    let daemon = new stratum_pool.daemon.interface([processingConfig.daemon], function (severity, message) {
        logger[severity](logSystem, logComponent, message);
    });
    let redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);

    const magnitude = 1000000000000000000;
    const minPaymentWei = parseInt(processingConfig.minimumPayment * magnitude);
    const coinPrecision = magnitude.toString().length - 1;

    let paymentInterval;

    async.parallel([
        function (callback) {
            daemon.cmd('validateaddress', [poolOptions.address], (result) => {
                if (result.error) {
                    logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                    callback(true);
                } else if (!result.response || !result.response.ismine) {
                    logger.error(logSystem, logComponent,
                        'Daemon does not own pool address - payment processing can not be done with this daemon, '
                        + JSON.stringify(result.response));
                    callback(true);
                }
                else {
                    callback()
                }
            }, true);
        }
    ], function (err) {
        if (err) {
            setupFinished(false);
            return;
        }
        paymentInterval = setInterval(function () {
            try {
                processPayments();
            } catch (e) {
                throw e;
            }
        }, processingConfig.paymentInterval * 1000);
        setTimeout(processPayments, 100);
        setupFinished(true);
    });


    let weiToCoins = function (wei) {
        return parseFloat((wei / magnitude).toFixed(coinPrecision));
    };

    let coinsToWei = function (coins) {
        return coins * magnitude;
    };

    /* Deal with numbers in smallest possible units (wei) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    let processPayments = function () {

        let startPaymentProcess = Date.now();

        let timeSpentRPC = 0;
        let timeSpentRedis = 0;

        let startTimeRedis;
        let startTimeRPC;

        let startRedisTimer = function () {
            startTimeRedis = Date.now()
        };
        let endRedisTimer = function () {
            timeSpentRedis += Date.now() - startTimeRedis
        };

        let startRPCTimer = function () {
            startTimeRPC = Date.now();
        };
        let endRPCTimer = function () {
            timeSpentRPC += Date.now() - startTimeRedis
        };

        async.waterfall([

            /* Call redis to get an array of rounds - which are coinbase transactions and block heights from submitted
               blocks. */
            function (callback) {

                startRedisTimer();
                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocksPending']
                ]).exec(function (error, results) {
                    endRedisTimer();

                    if (error) {
                        logger.error(logSystem, logComponent, 'Could not get blocks from redis ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    let workers = {};
                    for (let w in results[0]) {
                        workers[w] = {balance: coinsToWei(parseFloat(results[0][w]))};
                    }

                    let rounds = results[1].map(function (r) {
                        let details = r.split(':');
                        return {
                            blockHash: details[0],
                            reward: details[1],
                            height: details[2],
                            serialized: r
                        };
                    });

                    // sort rounds by block height to pay in order
                    rounds.sort(function (a, b) {
                        return a.height - b.height;
                    });

                    callback(null, workers, rounds);
                });
            },

            /* Does a batch rpc call to daemon with all the transaction hashes to see if they are confirmed yet.
               It also adds the block reward amount to the round object - which the daemon gives also gives us. */
            function (workers, rounds, callback) {
                let lastBlockNumber;
                daemon.cmd('eth_getBlockByNumber', ["latest"], function (result) {
                    if (result[0].response) {
                        lastBlockNumber = result[0].response.number;
                    }
                });

                let batchRPCcommand = rounds.map(function (r) {
                    return ['eth_getBlockByNumber', [r.height, false]];
                });

                startRPCTimer();
                daemon.batchCmd(batchRPCcommand, function (error, blocksDetails) {
                    endRPCTimer();

                    if (error || !blocksDetails) {
                        logger.error(logSystem, logComponent, 'Check finished - daemon rpc error with batch getBlockByHash '
                            + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    blocksDetails.forEach(function (block, i) {
                        let round = rounds[i];
                        //we have invalid block details returned, either from invalid hash or block has not been mined
                        if (!block.result.miner) {
                            round.category = 'kicked';
                            return;
                        }

                        if (block.result.miner === poolOptions.address) {
                            round.category = 'generate';
                        } else {
                            round.category = 'kicked';
                        }

                        if (round.category === 'generate' && !isConfirmedBlock(block, lastBlockNumber)) {
                            round.category = 'immature'
                        }

                    });

                    let canDeleteShares = function (r) {
                        for (let i = 0; i < rounds.length; i++) {
                            let compareR = rounds[i];
                            if ((compareR.height === r.height)
                                && (compareR.category !== 'kicked')
                                && (compareR.category !== 'orphan')
                                && (compareR.serialized !== r.serialized)) {
                                return false;
                            }
                        }
                        return true;
                    };


                    //Filter out all rounds that are immature (not confirmed or orphaned yet)
                    rounds = rounds.filter(function (r) {
                        switch (r.category) {
                            case 'orphan':
                            case 'kicked':
                                r.canDeleteShares = canDeleteShares(r);
                            case 'generate':
                                return true;
                            default:
                                return false;
                        }
                    });

                    callback(null, workers, rounds);
                });
            },


            /* Does a batch redis call to get shares contributed to each round. Then calculates the reward
               amount owned to each miner for each round. */
            function (workers, rounds, callback) {


                let shareLookups = rounds.map(function (r) {
                    return ['hgetall', coin + ':shares:round' + r.height]
                });

                startRedisTimer();
                redisClient.multi(shareLookups).exec(function (error, allWorkerShares) {
                    endRedisTimer();

                    if (error) {
                        callback('Check finished - redis error with multi get rounds share');
                        return;
                    }


                    rounds.forEach(function (round, i) {
                        let workerShares = allWorkerShares[i];

                        if (!workerShares) {
                            logger.error(logSystem, logComponent, 'No worker shares for round: '
                                + round.height + ' blockHash: ' + round.blockHash);
                            return;
                        }

                        switch (round.category) {
                            case 'kicked':
                            case 'orphan':
                                round.workerShares = workerShares;
                                break;
                            case 'generate':
                                /* We found a confirmed block! Now get the reward for it and calculate how much
                                   we owe each miner based on the shares they submitted during that block round. */
                                let reward = parseInt(round.reward * magnitude);

                                let totalShares = Object.keys(workerShares).reduce(function (p, c) {
                                    return p + parseFloat(workerShares[c])
                                }, 0);

                                for (let workerAddress in workerShares) {
                                    let percent = parseFloat(workerShares[workerAddress]) / totalShares;
                                    let workerRewardTotal = Math.floor(reward * percent);
                                    let worker = workers[workerAddress] = (workers[workerAddress] || {});
                                    worker.reward = (worker.reward || 0) + workerRewardTotal;
                                }
                                break;
                        }
                    });

                    callback(null, workers, rounds);
                });
            },


            /* Calculate if any payments are ready to be sent and trigger them sending
             Get balance different for each address and pass it along as object of latest balances such as
             {worker1: balance1, worker2, balance2}
             when deciding the sent balance, it the difference should be -1*amount they had in db,
             if not sending the balance, the difference should be +(the amount they earned this round)
             */
            function (workers, rounds, callback) {

                let trySend = function (withholdPercent) {
                    const poolAddress = poolOptions.address;
                    let addressAmounts = {};
                    let totalSent = 0;
                    let totalRewardWithholdPercentage = 0;
                    let totalRewardBeforeWitholds = 0;

                    Object.keys(poolOptions.rewardRecipients).forEach(function (key) {
                        totalRewardWithholdPercentage += poolOptions.rewardRecipients[key];
                    });

                    for (let w in workers) {
                        let worker = workers[w];
                        worker.balance = worker.balance || 0;
                        worker.reward = worker.reward || 0;
                        totalRewardBeforeWitholds += worker.reward;
                        let toSend = parseInt(worker.reward * (1 - (withholdPercent + totalRewardWithholdPercentage)));
                        if (toSend >= minPaymentWei) {
                            totalSent += toSend;
                            let address = worker.address = (worker.address || getProperAddress(w));
                            worker.sent = addressAmounts[address] = weiToCoins(toSend);
                            worker.balanceChange = Math.min(worker.balance, toSend) * -1;
                            worker.reward = toSend;
                        }
                        else {
                            worker.balanceChange = Math.max(toSend - worker.balance, 0);
                            worker.sent = 0;
                        }
                    }

                    if (Object.keys(addressAmounts).length === 0) {
                        callback(null, workers, rounds);
                        return;
                    }

                    let sendTransactionCalls = [];
                    let transactionHashes = [];
                    minersRewardLogger.log("Start sending the payments to miners...");
                    for (w in workers) {
                        let worker = workers[w];

                        if (worker.address === poolAddress) {
                            logger.debug('Master', 'Payment processor', 'Pool has same address as worker, not sending reward');
                            continue;
                        }

                        let transactionData = {
                            from: poolAddress,
                            to: w,
                            value: worker.reward
                        };
                        minersRewardLogger.log('Sending ' + worker.reward / magnitude + " AION to " + w);
                        sendTransactionCalls.push(sendTransactionCall(transactionData, withholdPercent, addressAmounts, totalSent, trySend));
                    }

                    if (sendTransactionCalls.length > 0) {
                       getTransactionDatasForPoolOps(totalRewardBeforeWitholds).forEach(function (element) {
                           sendTransactionCalls.push(sendTransactionCall(element, withholdPercent, addressAmounts, totalSent, trySend));
                       });
                    }

                    async.parallel(sendTransactionCalls, function (err, transactions) {
                        logger.debug(logSystem, logComponent, 'Sent out a total of ' + (totalSent / magnitude)
                            + ' to ' + Object.keys(transactions).length + ' addresses (including pool\'s)');
                        transactions.forEach(transaction => {
                            if (transaction && transaction.error) {
                                //TODO:  error management
                            } else {
                                transactionHashes.push(transaction);
                            }
                        });

                        callback(null, workers, rounds, transactionHashes);
                        minersRewardLogger.log("Payments were sent...");
                        callback(null, workers, rounds);
                    });
                };

                trySend(0);
            },
            function (workers, rounds, transactions, callback) {

                let totalPaid = 0;

                let balanceUpdateCommands = [];
                let workerPayoutsCommand = [];

                for (let w in workers) {
                    let worker = workers[w];
                    if (worker.balanceChange !== 0) {
                        balanceUpdateCommands.push([
                            'hincrbyfloat',
                            coin + ':balances',
                            w,
                            weiToCoins(worker.balanceChange)
                        ]);
                    }
                    if (worker.sent !== 0) {
                        workerPayoutsCommand.push(['hincrbyfloat', coin + ':payouts', w, worker.sent]);
                        totalPaid += worker.sent;
                    }
                }

                let movePendingCommands = [];
                let roundsToDelete = [];
                let orphanMergeCommands = [];
                let transactionCommands = [];

                transactions.forEach(function (transaction) {
                    transactionCommands.push(['sadd', coin + ':transactions', [transaction.txHash, transaction.to, transaction.amount].join(':')])
                });

                let moveSharesToCurrent = function (r) {
                    let workerShares = r.workerShares;
                    Object.keys(workerShares).forEach(function (worker) {
                        orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent',
                            worker, workerShares[worker]]);
                    });
                };

                rounds.forEach(function (r) {
                    switch (r.category) {
                        case 'kicked':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksKicked', r.serialized]);
                        case 'orphan':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksOrphaned', r.serialized]);
                            if (r.canDeleteShares) {
                                moveSharesToCurrent(r);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                            }
                            return;
                        case 'generate':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksConfirmed', r.serialized]);
                            roundsToDelete.push(coin + ':shares:round' + r.height);
                            return;
                    }

                });

                let finalRedisCommands = [];

                if (transactionCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(transactionCommands);

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (balanceUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

                if (workerPayoutsCommand.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(['del'].concat(roundsToDelete));

                if (totalPaid !== 0)
                    finalRedisCommands.push(['hincrbyfloat', coin + ':stats', 'totalPaid', totalPaid]);

                if (finalRedisCommands.length === 0) {
                    callback();
                    return;
                }

                startRedisTimer();
                redisClient.multi(finalRedisCommands).exec(function (error, results) {
                    endRedisTimer();
                    if (error) {
                        clearInterval(paymentInterval);
                        logger.error(logSystem, logComponent,
                            'Payments sent but could not update redis. ' + JSON.stringify(error)
                            + ' Disabling payment processing to prevent possible double-payouts. The redis commands in '
                            + coin + '_finalRedisCommands.txt must be ran manually');
                        fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), function (err) {
                            logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                        });
                    }
                    callback();
                });
            }

        ], function () {
            let paymentProcessTime = Date.now() - startPaymentProcess;
            logger.debug(logSystem, logComponent, 'Finished interval - time spent: '
                + paymentProcessTime + 'ms total, ' + timeSpentRedis + 'ms redis, '
                + timeSpentRPC + 'ms daemon RPC');

        });
    };


    let getProperAddress = (address) => {
        if (address.length === 40) {
            return util.addressFromEx(poolOptions.address, address);
        }
        else return address;
    };

    let isLockedAccount = (account, callback) => {
        return daemon.cmd('eth_sign', [account, ""], function (result) {
            result[0].error ? callback(true) : callback(false);
        })
    };

    let unlockAccountIfNecessary = (account, password, callback) => {
        isLockedAccount(account, function (isLocked) {
            if (isLocked) {
                daemon.cmd('personal_unlockAccount', [account, password], function (result) {
                    result[0].error ? callback(false) : callback(true);
                })
            } else {
                callback(true);
            }
        });
    };

    let isConfirmedBlock = (block, lastBlockNumber) => {
        return (lastBlockNumber - block.result.number) >= poolOptions.paymentProcessing.minimumConfirmationsShield;
    };

    let sendTransactionCall = (transactionData, withholdPercent, addressAmounts, totalSent, trySend) => {
        return function (callback) {
            unlockAccountIfNecessary(transactionData.from, poolOptions.addressPassword, function (isUnlocked) {
                if (isUnlocked) {
                    logger.debug(logSystem, logComponent, "Sending " + transactionData.value / magnitude + " AION to " + transactionData.to);
                    daemon.cmd('eth_sendTransaction', [transactionData], function (result) {
                        if (result[0].error && result[0].error.code === -6) {
                            let higherPercent = withholdPercent + 0.01;
                            logger.warning(logSystem, logComponent, 'Not enough funds to cover the tx fees for sending out payments, decreasing rewards by '
                                + (higherPercent * 100) + '% and retrying');
                            trySend(higherPercent);
                        }
                        else if (result[0].error) {
                            logger.error(logSystem, logComponent, 'Error trying to send payments with RPC eth_sendTransaction '
                                + JSON.stringify(result.error));
                            callback(result, null);
                        }
                        else {
                            if (withholdPercent > 0) {
                                logger.warning(logSystem, logComponent, 'Had to withhold ' + (withholdPercent * 100)
                                    + '% of reward from miners to cover transaction fees. '
                                    + 'Fund pool wallet with coins to prevent this from happening');
                            }

                            const transactionDetails = {};
                            transactionDetails.txHash = result[0].response;
                            transactionDetails.to = transactionData.to;
                            transactionDetails.amount = transactionData.value;

                            callback(null, transactionDetails);
                        }
                    });
                } else {
                    callback(true);
                }
            });
        }
    };

    let getTransactionDatasForPoolOps = (totalReward) => {
        let transactionsDatas = [];
        Object.keys(poolOptions.rewardRecipients).forEach(function (key) {
            const reward = parseInt(totalReward * poolOptions.rewardRecipients[key]);

            let transactionData = {
                from: poolOptions.address,
                to: key,
                value: reward
            };

            transactionsDatas.push(transactionData);
        });

        return transactionsDatas;
    }
}
