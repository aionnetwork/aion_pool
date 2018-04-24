const redis = require('redis');
const stratum_pool = require('stratum-pool');
const async = require('async');
const TransactionProcessor = require('./transactionProcessor');

module.exports = function (logger, minersRewardLogger) {
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
    let transactionProcessor = new TransactionProcessor(logger, logSystem, logComponent, magnitude, daemon, poolOptions, minersRewardLogger);


    this.checkTransactions = function () {
        if (!poolOptions.paymentProcessing || !poolOptions.paymentProcessing.enabled) {
            return;
        }

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
                    const sendTransactionCalls = [];

                    invalidTransactions.forEach(invalidTransaction => {
                        let transactionData = {
                            from: poolOptions.address,
                            to: invalidTransaction.worker,
                            value: invalidTransaction.amount
                        };
                        sendTransactionCalls.push(transactionProcessor.sendTransactionCall(transactionData, withholdPercent, trySend));
                    });

                    const failedTransactions = [];
                    async.parallel(sendTransactionCalls, function (err, transactions) {
                        if (err) {
                            logger.debug(logSystem, logComponent, 'Error while unlocking the account - you might want to ' +
                                'check your password');
                        }

                        transactions.forEach(transaction => {
                            if (transaction.txHash === "-1") {
                                failedTransactions.push(transaction);
                            }
                        });

                        updateRedis(failedTransactions);
                    });
                });
            };

            trySend(0);
        })
    };

    let updateRedis = function (failedTransactions) {
        redisClient.del("aion:transactions", function (result) {
            const transactionCommands = [];
            failedTransactions.forEach(transaction => {
                transactionCommands.push(['sadd', coin + ':transactions', [transaction.txHash, transaction.to, transaction.amount].join(':')])
            });

            redisClient.multi(transactionCommands).exec();
        })
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
