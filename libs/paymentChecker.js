const redis = require('redis');
const stratum_pool = require('stratum-pool');
const async = require('async');

module.exports = function (logger) {
    const poolConfigs = JSON.parse(process.env.pools);

    Object.keys(poolConfigs).forEach((coin) => {
        let poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing && poolOptions.paymentProcessing.enabled) {
            PaymentChecker(logger, coin, poolOptions);
        }
    });
};

let PaymentChecker = function (logger, coin, poolOptions) {
    const logSystem = 'Payments Checker';
    const logComponent = coin;
    const paymentProcessingConfig = poolOptions.paymentProcessing;

    const redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);
    const daemon = new stratum_pool.daemon.interface([paymentProcessingConfig.daemon],
        function (severity, message) {
            logger[severity](logSystem, logComponent, message);
        });

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

        const transactionValidityCalls = transactions.map(checkIfTransactionWasSuccessful);
        async.parallel(transactionValidityCalls, function (error, transactionsDetails) {
            const invalidTransactions = transactionsDetails.filter(transactionDetails => !transactionDetails.processed);

        })
    });

    let checkIfTransactionWasSuccessful = function (transactionDetails) {
        return function (callback) {
            daemon.cmd('eth_getTransactionByHash', [transactionDetails], function (result) {
                transactionDetails.processed = !result[0].error;
                callback(null, transactionDetails);
            })
        }
    };
};

