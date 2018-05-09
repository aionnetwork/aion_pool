const redis = require('redis');
const stratum_pool = require('stratum-pool');
const async = require('async');
const TransactionProcessor = require('./transactionProcessor');
const PaymentsLogger = require('./logging/rewardLogger');
const paymentsLogger = new PaymentsLogger('logs/miners_rewards');

module.exports = function (logger) {
    const poolConfigs = JSON.parse(process.env.pools);
    const coin = 'aion';
    let poolOptions = poolConfigs[coin];
    const logSystem = 'Payments Checker';
    const logComponent = coin;
    const paymentProcessingConfig = poolOptions.paymentProcessing;
    const magnitude = 1000000000000000000;

    const redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);
    const daemon = new stratum_pool.daemon.interface([paymentProcessingConfig.daemon],
        function (severity, message) {
            logger[severity](logSystem, logComponent, message);
        });
    let transactionProcessor = new TransactionProcessor(logger, logSystem, logComponent, magnitude, daemon, poolOptions, paymentsLogger);


    this.checkTransactions = function () {
        if (!poolOptions.paymentProcessing || !poolOptions.paymentProcessing.enabled) {
            return;
        }
        paymentsLogger.log('Start checking for failed transactions...');
        redisClient.smembers(coin + ':transactions', function (error, result) {
            if (error) {
                logger.error(logSystem, logComponent, 'Could not get transactions from redis ' + JSON.stringify(error));
                return;
            }

            const transactions = result.map((transactionDetail) => {
                const transactionData = transactionDetail.split(':');
                return {
                    txHash: transactionData[0],
                    worker: transactionData[1],
                    amount: transactionData[2]
                }
            });

            let trySend = function (withholdPercent) {
                const transactionValidityCalls = transactions.map(checkIfTransactionWasSuccessful);
                async.parallel(transactionValidityCalls, function (error, transactionsDetails) {
                    const invalidTransactions = transactionsDetails.filter(transactionDetails => !transactionDetails.processed);
                    const toDelete  = transactionsDetails.filter(transactionDetails => transactionDetails.processed);
                    const sendTransactionCalls = [];

                    invalidTransactions.forEach(invalidTransaction => {
                        let transactionData = {
                            from: poolOptions.address,
                            to: invalidTransaction.worker,
                            value: invalidTransaction.amount,
                            previousHash: invalidTransaction.txHash
                        };
                        paymentsLogger.log('Failed to send ' + invalidTransaction.amount / magnitude + ' AION to ' + invalidTransaction.worker + '. Retrying...');
                        sendTransactionCalls.push(transactionProcessor.sendTransactionCall(transactionData, withholdPercent, trySend));
                    });

                    async.parallel(sendTransactionCalls, function (err, transactions) {
                        if (err) {
                            logger.debug(logSystem, logComponent, 'Error while unlocking the account - you might want to ' +
                                'check your password');
                        }

                        const newTransactions = [];
                        transactions.forEach(transaction => {
                            newTransactions.push(transaction);
                            toDelete.push({txHash: transaction.previousHash, worker: transaction.to, amount: transaction.amount})
                        });

                        updateRedis(toDelete, newTransactions);
                    });
                });
            };

            trySend(0);
        })
    };

    let updateRedis = function (toDelete, toAdd) {
        const deleteTransactionCommands = [];
        const addTransactionCommands = [];
        toDelete.forEach(transaction => {
            deleteTransactionCommands.push(['srem', coin + ':transactions', [transaction.txHash, transaction.worker, transaction.amount].join(':')]);
        });
        toAdd.forEach(transaction => {
            addTransactionCommands.push(['sadd', coin + ":transactions", [transaction.txHash, transaction.to, transaction.amount].join(':')])
        });

        let finalRedisCommands = [];
        if (deleteTransactionCommands.length > 0) {
            finalRedisCommands = finalRedisCommands.concat(deleteTransactionCommands);
        }
        if (addTransactionCommands.length > 0) {
            finalRedisCommands = finalRedisCommands.concat(addTransactionCommands);
        }

        redisClient.multi(finalRedisCommands).exec(function (error, results) {

        });
    };

    let checkIfTransactionWasSuccessful = function (transactionDetails) {
        return function (callback) {
            if (transactionDetails.txHash !== "-1") {
                daemon.cmd('eth_getTransactionByHash', [transactionDetails.txHash], function (result) {
                    transactionDetails.processed = !result[0].error;
                    callback(null, transactionDetails);
                });
            } else {
                transactionDetails.processed = false;
                callback(null, transactionDetails);
            }
        }
    };
};
