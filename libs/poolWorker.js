const Stratum = require('stratum-pool');
const redis = require('redis');
const net = require('net');

const MposCompatibility = require('./mposCompatibility.js');
const ShareProcessor = require('./shareProcessor.js');

module.exports = function(logger){

    const _this = this;

    const poolConfigs = JSON.parse(process.env.pools);
    const portalConfig = JSON.parse(process.env.portalConfig);

    const forkId = process.env.forkId;

    const pools = {};

    const proxySwitch = {};

    const redisClient = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);

    //Handle messages from master process sent via IPC
    process.on('message', function(message) {
        switch(message.type){

            case 'banIP':
                for (let p in pools){
                    if (pools[p].stratumServer)
                        pools[p].stratumServer.addBannedIP(message.ip);
                }
                break;

            case 'blocknotify':

                const messageCoin = message.coin.toLowerCase();
                const poolTarget = Object.keys(pools).filter(function (p) {
                    return p.toLowerCase() === messageCoin;
                })[0];

                if (poolTarget)
                    pools[poolTarget].processBlockNotify(message.hash, 'blocknotify script');

                break;

            // IPC message for pool switching
            case 'coinswitch':
                const logSystem = 'Proxy';
                const logComponent = 'Switch';
                const logSubCat = 'Thread ' + (parseInt(forkId) + 1);

                const switchName = message.switchName;

                const newCoin = message.coin;

                const algo = poolConfigs[newCoin].coin.algorithm;

                const newPool = pools[newCoin];
                const oldCoin = proxySwitch[switchName].currentPool;
                const oldPool = pools[oldCoin];
                const proxyPorts = Object.keys(proxySwitch[switchName].ports);

                if (newCoin == oldCoin) {
                    logger.debug(logSystem, logComponent, logSubCat, 'Switch message would have no effect - ignoring ' + newCoin);
                    break;
                }

                logger.debug(logSystem, logComponent, logSubCat, 'Proxy message for ' + algo + ' from ' + oldCoin + ' to ' + newCoin);

                if (newPool) {
                    oldPool.relinquishMiners(
                        function (miner, cback) { 
                            // relinquish miners that are attached to one of the "Auto-switch" ports and leave the others there.
                            cback(proxyPorts.indexOf(miner.client.socket.localPort.toString()) !== -1)
                        }, 
                        function (clients) {
                            newPool.attachMiners(clients);
                        }
                    );
                    proxySwitch[switchName].currentPool = newCoin;

                    redisClient.hset('proxyState', algo, newCoin, function(error, obj) {
                        if (error) {
                            logger.error(logSystem, logComponent, logSubCat, 'Redis error writing proxy config: ' + JSON.stringify(err))
                        }
                        else {
                            logger.debug(logSystem, logComponent, logSubCat, 'Last proxy state saved to redis for ' + algo);
                        }
                    });

                }
                break;
        }
    });


    Object.keys(poolConfigs).forEach(function(coin) {

        const poolOptions = poolConfigs[coin];

        const logSystem = 'Pool';
        const logComponent = coin;
        const logSubCat = 'Thread ' + (parseInt(forkId) + 1);

        const handlers = {
            auth: function () {
            },
            share: function () {
            },
            diff: function () {
            }
        };

        //Functions required for MPOS compatibility
        if (poolOptions.mposMode && poolOptions.mposMode.enabled){
            const mposCompat = new MposCompatibility(logger, poolOptions);

            handlers.auth = function(port, workerName, password, authCallback){
                mposCompat.handleAuth(workerName, password, authCallback);
            };

            handlers.share = function(isValidShare, isValidBlock, data){
                mposCompat.handleShare(isValidShare, isValidBlock, data);
            };

            handlers.diff = function(workerName, diff){
                mposCompat.handleDifficultyUpdate(workerName, diff);
            }
        }

        //Functions required for internal payment processing
        else{

            const shareProcessor = new ShareProcessor(logger, poolOptions);

            handlers.auth = function(port, workerName, password, authCallback){
                if (poolOptions.validateWorkerUsername !== true)
                    authCallback(true);
                else {
                    if (workerName.length === 40) {
                        try {
                            new Buffer(workerName, 'hex');
                            authCallback(true);
                        }
                        catch (e) {
                            authCallback(false);
                        }
                    }
                    else {
                        pool.daemon.cmd('validateaddress', [workerName], function (results) {
                            const isValid = results.filter(function (r) {
                                return r.response.isvalid
                            }).length > 0;
                            authCallback(isValid);
                        });
                    }

                }
            };

            handlers.share = function(isValidShare, isValidBlock, data){
                shareProcessor.handleShare(isValidShare, isValidBlock, data);
            };
        }

        const authorizeFN = function (ip, port, workerName, password, callback) {
            handlers.auth(port, workerName, password, function (authorized) {

                const authString = authorized ? 'Authorized' : 'Unauthorized ';

                logger.debug(logSystem, logComponent, logSubCat, authString + ' ' + workerName + ':' + password + ' [' + ip + ']');
                callback({
                    error: null,
                    authorized: authorized,
                    disconnect: false
                });
            });
        };


        var pool = Stratum.createPool(poolOptions, authorizeFN, logger);
        pool.on('share', function(isValidShare, isValidBlock, data){

            const shareData = JSON.stringify(data);

            if (data.blockHash && !isValidBlock)
                logger.debug(logSystem, logComponent, logSubCat, 'We thought a block was found but it was rejected by the daemon, share data: ' + shareData);

            else if (isValidBlock)
                logger.debug(logSystem, logComponent, logSubCat, 'Block found: ' + data.blockHash + ' by ' + data.worker);

            if (isValidShare) {
                if(data.shareDiff > 1000000000)
                    logger.debug(logSystem, logComponent, logSubCat, 'Share was found with diff higher than 1.000.000.000!');
                else if(data.shareDiff > 1000000)
                    logger.debug(logSystem, logComponent, logSubCat, 'Share was found with diff higher than 1.000.000!');
                logger.debug(logSystem, logComponent, logSubCat, 'Share accepted at diff ' + data.difficulty + '/' + data.shareDiff + ' by ' + data.worker + ' [' + data.ip + ']' );

            } else if (!isValidShare)
                logger.debug(logSystem, logComponent, logSubCat, 'Share rejected: ' + shareData);

            handlers.share(isValidShare, isValidBlock, data)


        }).on('difficultyUpdate', function(workerName, diff){
            logger.debug(logSystem, logComponent, logSubCat, 'Difficulty update to diff ' + diff + ' workerName=' + JSON.stringify(workerName));
            handlers.diff(workerName, diff);
        }).on('log', function(severity, text) {
            logger[severity](logSystem, logComponent, logSubCat, text);
        }).on('banIP', function(ip, worker){
            process.send({type: 'banIP', ip: ip});
        }).on('started', function(){
            _this.setDifficultyForProxyPort(pool, poolOptions.coin.name, poolOptions.coin.algorithm);
        });

        pool.start();
        pools[poolOptions.coin.name] = pool;
    });

    if (portalConfig.switching) {
        var logSystem = 'Switching';
        var logComponent = 'Setup';
        var logSubCat = 'Thread ' + (parseInt(forkId) + 1);

        let proxyState = {};

        //
        // Load proxy state for each algorithm from redis which allows NOMP to resume operation
        // on the last pool it was using when reloaded or restarted
        //
        logger.debug(logSystem, logComponent, logSubCat, 'Loading last proxy state from redis');



        /*redisClient.on('error', function(err){
            logger.debug(logSystem, logComponent, logSubCat, 'Pool configuration failed: ' + err);
        });*/

        redisClient.hgetall("proxyState", function(error, obj) {
            if (!error && obj) {
                proxyState = obj;
                logger.debug(logSystem, logComponent, logSubCat, 'Last proxy state loaded from redis');
            }

            //
            // Setup proxySwitch object to control proxy operations from configuration and any restored
            // state.  Each algorithm has a listening port, current coin name, and an active pool to
            // which traffic is directed when activated in the config.
            //
            // In addition, the proxy config also takes diff and varDiff parmeters the override the
            // defaults for the standard config of the coin.
            //
            Object.keys(portalConfig.switching).forEach(function(switchName) {

                const algorithm = portalConfig.switching[switchName].algorithm;

                if (!portalConfig.switching[switchName].enabled) return;


                const initalPool = proxyState.hasOwnProperty(algorithm) ? proxyState[algorithm] : _this.getFirstPoolForAlgorithm(algorithm);
                proxySwitch[switchName] = {
                    algorithm: algorithm,
                    ports: portalConfig.switching[switchName].ports,
                    currentPool: initalPool,
                    servers: []
                };


                Object.keys(proxySwitch[switchName].ports).forEach(function(port){
                    const f = net.createServer(function (socket) {
                        const currentPool = proxySwitch[switchName].currentPool;

                        logger.debug(logSystem, 'Connect', logSubCat, 'Connection to '
                            + switchName + ' from '
                            + socket.remoteAddress + ' on '
                            + port + ' routing to ' + currentPool);

                        if (pools[currentPool])
                            pools[currentPool].getStratumServer().handleNewClient(socket);
                        else
                            pools[initalPool].getStratumServer().handleNewClient(socket);

                    }).listen(parseInt(port), function () {
                        logger.debug(logSystem, logComponent, logSubCat, 'Switching "' + switchName
                            + '" listening for ' + algorithm
                            + ' on port ' + port
                            + ' into ' + proxySwitch[switchName].currentPool);
                    });
                    proxySwitch[switchName].servers.push(f);
                });

            });
        });
    }
    this.getFirstPoolForAlgorithm = function(algorithm) {
        let foundCoin = "";
        Object.keys(poolConfigs).forEach(function(coinName) {
            if (poolConfigs[coinName].coin.algorithm == algorithm) {
                if (foundCoin === "")
                    foundCoin = coinName;
            }
        });
        return foundCoin;
    };

    //
    // Called when stratum pool emits its 'started' event to copy the initial diff and vardiff 
    // configuation for any proxy switching ports configured into the stratum pool object.
    //
    this.setDifficultyForProxyPort = function(pool, coin, algo) {

        logger.debug(logSystem, logComponent, algo, 'Setting proxy difficulties after pool start');

        Object.keys(portalConfig.switching).forEach(function(switchName) {
            if (!portalConfig.switching[switchName].enabled) return;

            const switchAlgo = portalConfig.switching[switchName].algorithm;
            if (pool.options.coin.algorithm !== switchAlgo) return;

            // we know the switch configuration matches the pool's algo, so setup the diff and 
            // vardiff for each of the switch's ports
            for (let port in portalConfig.switching[switchName].ports) {

                if (portalConfig.switching[switchName].ports[port].varDiff)
                    pool.setVarDiff(port, portalConfig.switching[switchName].ports[port].varDiff);

                if (portalConfig.switching[switchName].ports[port].diff){
                    if (!pool.options.ports.hasOwnProperty(port)) 
                        pool.options.ports[port] = {};
                    pool.options.ports[port].diff = portalConfig.switching[switchName].ports[port].diff;
                }
            }
        });
    };
};
