var zlib = require('zlib');

var redis = require('redis');
var async = require('async');
const stratum_pool = require('stratum-pool');

var os = require('os');

var algos = require('stratum-pool/lib/algos.js');


module.exports = function(logger, portalConfig, poolConfigs){

    var _this = this;

    var logSystem = 'Stats';

    var redisClients = [];
    var redisStats;
    var rpcDaemons = {};

    this.statHistory = [];
    this.statPoolHistory = [];

    this.stats = {};
    this.statsString = '';

    setupStatsRedis();
    gatherStatHistory();

    var canDoStats = true;

    Object.keys(poolConfigs).forEach(function(coin){

        if (!canDoStats) return;

        var poolConfig = poolConfigs[coin];

        var redisConfig = poolConfig.redis;

        for (var i = 0; i < redisClients.length; i++){
            var client = redisClients[i];
            if (client.client.port === redisConfig.port && client.client.host === redisConfig.host){
                client.coins.push(coin);
                return;
            }
        }
        redisClients.push({
            coins: [coin],
            client: redis.createClient(redisConfig.port, redisConfig.host)
        });

        rpcDaemons[coin] = new stratum_pool.daemon.interface([poolConfig.paymentProcessing.daemon], function (severity, message) {
            logger[severity](logSystem, coin, message);
        });
    });


    function setupStatsRedis(){
        redisStats = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);
        redisStats.on('error', function(err){
            logger.error(logSystem, 'Historics', 'Redis for stats had an error ' + JSON.stringify(err));
        });
    }

    function gatherStatHistory(){

        var retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0).toString();

        redisStats.zrangebyscore(['statHistory', retentionTime, '+inf'], function(err, replies){
            if (err) {
                logger.error(logSystem, 'Historics', 'Error when trying to grab historical stats ' + JSON.stringify(err));
                return;
            }
            for (var i = 0; i < replies.length; i++){
                _this.statHistory.push(JSON.parse(replies[i]));
            }
            _this.statHistory = _this.statHistory.sort(function(a, b){
                return a.time - b.time;
            });
            _this.statHistory.forEach(function(stats){
                addStatPoolHistory(stats);
            });
        });
    }

    function addStatPoolHistory(stats){
        var data = {
            time: stats.time,
            pools: {}
        };
        for (var pool in stats.pools){
            data.pools[pool] = {
                hashrate: stats.pools[pool].hashrate,
                percent: stats.pools[pool].percent,
                workerCount: stats.pools[pool].workerCount,
                blocks: stats.pools[pool].blocks
            }
        }
        _this.statPoolHistory.push(data);
    }

    this.getGlobalStats = function(callback){

        var statGatherTime = Date.now() / 1000 | 0;

        var allCoinStats = {};

        var allCoinHashrates = {};

        rpcDaemons["aion"].cmd('getMinerStats', [poolConfigs["aion"].address], function (result) {
            //console.log(result[0].response.minerHashrate);
            allCoinHashrates["aion"] = {
                hashrate: 0,
                percent: 0
            };

            if (result[0] && result[0].response) {                
                if (result[0].response.minerHashrate)
                    allCoinHashrates["aion"].hashrate = parseFloat(result[0].response.minerHashrate);
                
                if (result[0].response.minerHashrateShare)
                    allCoinHashrates["aion"].percent = parseFloat(result[0].response.minerHashrateShare);
            } 

            async.each(redisClients, function(client, callback){
                var windowTime = (((Date.now() / 1000) - portalConfig.website.stats.hashrateWindow) | 0).toString();
                var redisCommands = [];

                var redisCommandTemplates = [
                    ['zremrangebyscore', ':hashrate', '-inf', '(' + windowTime],
                    ['zrangebyscore', ':hashrate', windowTime, '+inf'],
                    ['hgetall', ':stats'],
                    ['scard', ':blocksPending'],
                    ['scard', ':blocksConfirmed'],
                    ['scard', ':blocksOrphaned']
                ];

                var commandsPerCoin = redisCommandTemplates.length;

                client.coins.map(function(coin){
                    redisCommandTemplates.map(function(t){
                        var clonedTemplates = t.slice(0);
                        clonedTemplates[1] = coin + clonedTemplates[1];
                        redisCommands.push(clonedTemplates);
                    });
                });


                client.client.multi(redisCommands).exec(function(err, replies){
                    if (err){
                        logger.error(logSystem, 'Global', 'error with getting global stats ' + JSON.stringify(err));
                        callback(err);
                    }
                    else{
                        for(var i = 0; i < replies.length; i += commandsPerCoin){
                            var coinName = client.coins[i / commandsPerCoin | 0];
                            var coinStats = {
                                name: coinName,
                                symbol: poolConfigs[coinName].coin.symbol.toUpperCase(),
                                algorithm: poolConfigs[coinName].coin.algorithm,
                                hashrates: replies[i + 1],
                                poolStats: {
                                    validShares: replies[i + 2] ? (replies[i + 2].validShares || 0) : 0,
                                    validBlocks: replies[i + 2] ? (replies[i + 2].validBlocks || 0) : 0,
                                    invalidShares: replies[i + 2] ? (replies[i + 2].invalidShares || 0) : 0,
                                    totalPaid: replies[i + 2] ? (replies[i + 2].totalPaid || 0) : 0
                                },
                                blocks: {
                                    pending: replies[i + 3],
                                    confirmed: replies[i + 4],
                                    orphaned: replies[i + 5]
                                }
                            };
                            allCoinStats[coinStats.name] = (coinStats);
                        }
                        callback();
                    }
                });
            }, function(err) {
                if (err){
                    logger.error(logSystem, 'Global', 'error getting all stats' + JSON.stringify(err));
                    callback();
                    return;
                }

                var portalStats = {
                    time: statGatherTime,
                    global:{
                        workers: 0,
                        hashrate: 0
                    },
                    algos: {},
                    pools: allCoinStats
                };

                Object.keys(allCoinStats).forEach(function(coin){
                    var coinStats = allCoinStats[coin];
                    coinStats.workers = {};
                    coinStats.shares = 0;
                    coinStats.hashrates.forEach(function(ins){
                        var parts = ins.split(':');
                        var workerShares = parseFloat(parts[0]);
                        var worker = parts[1];
                        if (workerShares > 0) {
                            coinStats.shares += workerShares;
                            if (worker in coinStats.workers)
                                coinStats.workers[worker].shares += workerShares;
                            else
                                coinStats.workers[worker] = {
                                    shares: workerShares,
                                    invalidshares: 0,
                                    hashrateString: null
                                };
                        }
                        else {
                            if (worker in coinStats.workers)
                                coinStats.workers[worker].invalidshares -= workerShares; // workerShares is negative number!
                            else
                                coinStats.workers[worker] = {
                                    shares: 0,
                                    invalidshares: -workerShares,
                                    hashrateString: null
                                };
                        }
                    });

                    //var shareMultiplier = Math.pow(2, 32) / algos[coinStats.algorithm].multiplier;
                    //coinStats.hashrate = shareMultiplier * coinStats.shares / portalConfig.website.stats.hashrateWindow;
                    coinStats.hashrate = allCoinHashrates[coin].hashrate;
                    coinStats.percent = allCoinHashrates[coin].percent;

                    coinStats.workerCount = Object.keys(coinStats.workers).length;
                    portalStats.global.workers += coinStats.workerCount;

                    /* algorithm specific global stats */
                    /*
                    var algo = coinStats.algorithm;
                    if (!portalStats.algos.hasOwnProperty(algo)){
                        portalStats.algos[algo] = {
                            workers: 0,
                            hashrate: 0,
                            hashrateString: null
                        };
                    }
                    portalStats.algos[algo].hashrate += coinStats.hashrate;
                    portalStats.algos[algo].workers += Object.keys(coinStats.workers).length;
                    
                    for (var worker in coinStats.workers) {
                        coinStats.workers[worker].hashrateString = _this.getReadableHashRateString(shareMultiplier * coinStats.workers[worker].shares / portalConfig.website.stats.hashrateWindow);
                    }*/

                    delete coinStats.hashrates;
                    delete coinStats.shares;
                    coinStats.hashrateString = _this.getRealReadableHashRateString(coinStats.hashrate);
                });

                /*
                Object.keys(portalStats.algos).forEach(function(algo){
                    var algoStats = portalStats.algos[algo];
                    algoStats.hashrateString = _this.getReadableHashRateString(algoStats.hashrate);
                });
                */

                _this.stats = portalStats;
                _this.statsString = JSON.stringify(portalStats);

                _this.statHistory.push(portalStats);
                addStatPoolHistory(portalStats);

                var retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0);

                for (var i = 0; i < _this.statHistory.length; i++){
                    if (retentionTime < _this.statHistory[i].time){
                        if (i > 0) {
                            _this.statHistory = _this.statHistory.slice(i);
                            _this.statPoolHistory = _this.statPoolHistory.slice(i);
                        }
                        break;
                    }
                }

                redisStats.multi([
                    ['zadd', 'statHistory', statGatherTime, _this.statsString],
                    ['zremrangebyscore', 'statHistory', '-inf', '(' + retentionTime]
                ]).exec(function(err, replies){
                    if (err)
                        logger.error(logSystem, 'Historics', 'Error adding stats to historics ' + JSON.stringify(err));
                });

                //console.log("rpc-call: BEFORE");
                //let poolOptions = poolConfigs["aion"];
                
                callback();
            });
        });

    };

    var units = [ ' Sol/s', ' KSol/s', ' MSol/s', ' GSol/s', ' TSol/s', ' PSol/s' ];

    this.getRealReadableHashRateString = function(number) {
        // what tier? (determines prefix)
        var tier = Math.log10(number) / 3 | 0;

        // get prefix and determine scale
        var prefix = units[tier];
        var scale = Math.pow(10, tier * 3);

        // scale the number
        var scaled = number / scale;

        // format number and add prefix as suffix
        return scaled.toFixed(2) + prefix;
    }

    /*
    this.getReadableHashRateString = function(hashrate) {
        hashrate = (hashrate * 2);
        if (hashrate < 1000000) {
            return (Math.round(hashrate / 1000) / 1000 ).toFixed(2)+' Sol/s';
        }
        var byteUnits = [ ' Sol/s', ' KSol/s', ' MSol/s', ' GSol/s', ' TSol/s', ' PSol/s' ];
        var i = Math.floor((Math.log(hashrate/100000) / Math.log(1000)) - 1) || 0;
        hashrate = (hashrate/100000) / Math.pow(1000, i + 1);
        return hashrate.toFixed(3) + byteUnits[i];
    }*/

};
