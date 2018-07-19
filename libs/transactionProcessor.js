module.exports = function (logger, logSystem, logComponent, magnitude, daemon, poolOptions, minersRewardLogger) {
    let isLockedAccount = (account, callback) => {
        return daemon.cmd('eth_sign', [account, ""], function (result) {
            result[0].error ? callback(true) : callback(false);
        })
    };

    let unlockAccountIfNecessary = (account, password, callback) => {
        isLockedAccount(account, function (isLocked) {
            if (isLocked) {
                daemon.cmd('personal_unlockAccount', [account, password], function (result) {
                    (result[0].error || !result[0].response) ? callback(false) : callback(true);
                })
            } else {
                callback(true);
            }
        });
    };

    this.sendTransactionCall = (transactionData, withholdPercent, trySend) => {
        return function (callback) {

            if (transactionData.value === undefined || transactionData.value === 0) {
                logger.debug("Transaction with 0 value. Not sending it.");
                callback();
                return;
            }

            const transactionDetails = {};
            transactionDetails.txHash = -1;
            transactionDetails.to = transactionData.to;
            transactionDetails.amount = transactionData.value;
            transactionDetails.previousHash = transactionData.previousHash;

            unlockAccountIfNecessary(transactionData.from, poolOptions.addressPassword, function (isUnlocked) {
                if (isUnlocked) {
                    minersRewardLogger.log("Sending " + transactionData.value / magnitude + " AION to " + transactionData.to);
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
                            callback(result, transactionDetails);
                        }
                        else {
                            if (withholdPercent > 0) {
                                logger.warning(logSystem, logComponent, 'Had to withhold ' + (withholdPercent * 100)
                                    + '% of reward from miners to cover transaction fees. '
                                    + 'Fund pool wallet with coins to prevent this from happening');
                            }

                            transactionDetails.txHash = result[0].response;
                            callback(null, transactionDetails);
                        }
                    });
                } else {
                    callback(true, transactionDetails);
                }
            });
        }
    }
};
