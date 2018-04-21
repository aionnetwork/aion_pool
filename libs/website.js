
var fs = require('fs');
var path = require('path');

var async = require('async');
var watch = require('node-watch');
var redis = require('redis');

var dot = require('dot');
var express = require('express');
var bodyParser = require('body-parser');
var compress = require('compression');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');

var api = require('./api.js');


module.exports = function(logger){

    dot.templateSettings.strip = false;

    var portalConfig = JSON.parse(process.env.portalConfig);
    var poolConfigs = JSON.parse(process.env.pools);

    var websiteConfig = portalConfig.website;

    var portalApi = new api(logger, portalConfig, poolConfigs);
    var portalStats = portalApi.stats;

    var logSystem = 'Website';

    var pageFiles = {
        'index.html': 'index',
        'home.html': '',
        'getting_started.html': 'getting_started',
        'stats.html': 'stats',
        'tbs.html': 'tbs',
        'workers.html': 'workers',
        'api.html': 'api',
        'admin.html': 'admin',
        'mining_key.html': 'mining_key',
        'worker_stats.html': 'worker_stats'
    };

    var pageTemplates = {};

    var pageProcessed = {};
    var indexesProcessed = {};

    var keyScriptTemplate = '';
    var keyScriptProcessed = '';


    var processTemplates = function(){

        for (var pageName in pageTemplates){
            if (pageName === 'index') continue;
            pageProcessed[pageName] = pageTemplates[pageName]({
                poolsConfigs: poolConfigs,
                stats: portalStats.stats,
                portalConfig: portalConfig,
                siprefixed: function(number) {
                    var units = ["", "k", "M", "G", "T", "P", "E"];

                    // what tier? (determines prefix)
                    var tier = Math.log10(number) / 3 | 0;

                    // if zero, we don't need a prefix
                    if(tier == 0) return number;

                    // get prefix and determine scale
                    var prefix = units[tier];
                    var scale = Math.pow(10, tier * 3);

                    // scale the number
                    var scaled = number / scale;

                    // format number and add prefix as suffix
                    return scaled + prefix;
                }
            });
            indexesProcessed[pageName] = pageTemplates.index({
                page: pageProcessed[pageName],
                selected: pageName,
                stats: portalStats.stats,
                poolConfigs: poolConfigs,
                portalConfig: portalConfig
            });
        }

        //logger.debug(logSystem, 'Stats', 'Website updated to latest stats');
    };



    var readPageFiles = function(files){
        async.each(files, function(fileName, callback){
            var filePath = 'website/' + (fileName === 'index.html' ? '' : 'pages/') + fileName;
            fs.readFile(filePath, 'utf8', function(err, data){
                var pTemp = dot.template(data);
                pageTemplates[pageFiles[fileName]] = pTemp;
                callback();
            });
        }, function(err){
            if (err){
                console.log('error reading files for creating dot templates: '+ JSON.stringify(err));
                return;
            }
            processTemplates();
        });
    };


    //If an html file was changed reload it
    // watch('website', function(filename){
    //     var basename = path.basename(filename);
    //     if (basename in pageFiles){
            
    //         readPageFiles([basename]);
    //         logger.debug(logSystem, 'Server', 'Reloaded file ' + basename);
    //     }
    // });

    portalStats.getGlobalStats(function(){
        readPageFiles(Object.keys(pageFiles));
    });

    var buildUpdatedWebsite = function(){
        portalStats.getGlobalStats(function(){
            processTemplates();

            var statData = 'data: ' + JSON.stringify(portalStats.stats) + '\n\n';
            for (var uid in portalApi.liveStatConnections){
                var res = portalApi.liveStatConnections[uid];
                res.write(statData);
            }

        });
    };
    // original:
    //setInterval(buildUpdatedWebsite, websiteConfig.stats.updateInterval * 1000);
    
    // change to a setTimeout()-based polling since we introduced a network call in the build 
    // function, which might** block for an interval longer than updateInterval 
    (function buildpages() {
        buildUpdatedWebsite();
        setTimeout(buildpages, websiteConfig.stats.updateInterval * 1000);
    }());

    var buildKeyScriptPage = function(){
        async.waterfall([
            function(callback){
                var client = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);
                client.hgetall('coinVersionBytes', function(err, coinBytes){
                    if (err){
                        client.quit();
                        return callback('Failed grabbing coin version bytes from redis ' + JSON.stringify(err));
                    }
                    callback(null, client, coinBytes || {});
                });
            },
            function (client, coinBytes, callback){
                var enabledCoins = Object.keys(poolConfigs).map(function(c){return c.toLowerCase()});
                var missingCoins = [];
                enabledCoins.forEach(function(c){
                    if (!(c in coinBytes))
                        missingCoins.push(c);
                });
                callback(null, client, coinBytes, missingCoins);
            },
            function(client, coinBytes, missingCoins, callback){
                var coinsForRedis = {};
                async.each(missingCoins, function(c, cback){
                    var coinInfo = (function(){
                        for (var pName in poolConfigs){
                            if (pName.toLowerCase() === c)
                                return {
                                    daemon: poolConfigs[pName].paymentProcessing.daemon,
                                    address: poolConfigs[pName].address
                                }
                        }
                    })();
                    var daemon = new Stratum.daemon.interface([coinInfo.daemon], function(severity, message){
                        logger[severity](logSystem, c, message);
                    });

                    // chris, comment this session out first
                    // daemon.cmd('dumpprivkey', [coinInfo.address], function(result){
                    //     if (result[0].error){
                    //         logger.error(logSystem, c, 'Could not dumpprivkey for ' + c + ' ' + JSON.stringify(result[0].error));
                    //         cback();
                    //         return;
                    //     }

                        
                    //     // aion address is 20 bytes without version byte prefix
                    //     var vBytePub = util.getVersionByte(coinInfo.address)[0];
                    //     var vBytePriv = util.getVersionByte(result[0].response)[0];
                    //     coinBytes[c] = vBytePub.toString() + ',' + vBytePriv.toString();
                    //     coinsForRedis[c] = coinBytes[c];
                    //     cback();
                    // });
                }, function(err){
                    callback(null, client, coinBytes, coinsForRedis);
                });
            },
            function(client, coinBytes, coinsForRedis, callback){
                if (Object.keys(coinsForRedis).length > 0){
                    client.hmset('coinVersionBytes', coinsForRedis, function(err){
                        if (err)
                            logger.error(logSystem, 'Init', 'Failed inserting coin byte version into redis ' + JSON.stringify(err));
                        client.quit();
                    });
                }
                else{
                    client.quit();
                }
                callback(null, coinBytes);
            }
        ], function(err, coinBytes){
            if (err){
                logger.error(logSystem, 'Init', err);
                return;
            }
            try{
                keyScriptTemplate = dot.template(fs.readFileSync('website/key.html', {encoding: 'utf8'}));
                keyScriptProcessed = keyScriptTemplate({coins: coinBytes});
            }
            catch(e){
                logger.error(logSystem, 'Init', 'Failed to read key.html file');
            }
        });

    };
    buildKeyScriptPage();

    var getPage = function(pageId){
        if (pageId in pageProcessed){
            var requestedPage = pageProcessed[pageId];
            return requestedPage;
        }
    };

    var route = function(req, res, next){
        var pageId = req.params.page || 'getting_started';
        if (pageId in indexesProcessed){
            res.header('Content-Type', 'text/html');
            res.end(indexesProcessed[pageId]);
        }
        else
            next();

    };

    var getWorkerStatsPage = function(workerId) {
        var workerStats = portalStats.stats.pools.aion.workers[workerId];
        var page = pageTemplates['worker_stats']({
            poolsConfigs: poolConfigs,
            stats: portalStats.stats,
            portalConfig: portalConfig,
            workerStats: workerStats,
            workerName: workerId
        });
        return pageTemplates.index({
            page: page,
            selected: 'workers',
            stats: portalStats.stats,
            poolConfigs: poolConfigs,
            portalConfig: portalConfig
        });
    };

    

    


    var app = express();


    app.use(bodyParser.json());

    app.get('/get_page', function(req, res, next){
        var requestedPage = getPage(req.query.id || 'getting_started');
        if (requestedPage){
            res.end(requestedPage);
            return;
        }
        next();
    });

    app.get('/key.html', function(req, res, next){
        res.end(keyScriptProcessed);
    });

    app.get('/workers/:workerId', function(req, res, next) {
        var workerId = req.params.workerId;
        console.log('Getting stats for worker ',  workerId);
        res.header('Content-Type', 'text/html');
        res.end(getWorkerStatsPage(workerId));
    });

    app.get('/:page', route);
    app.get('/', route);

    app.get('/api/:method', function(req, res, next){
        portalApi.handleApiRequest(req, res, next);
    });

    app.post('/api/admin/:method', function(req, res, next){
        if (portalConfig.website
            && portalConfig.website.adminCenter
            && portalConfig.website.adminCenter.enabled){
            if (portalConfig.website.adminCenter.password === req.body.password)
                portalApi.handleAdminApiRequest(req, res, next);
            else
                res.send(401, JSON.stringify({error: 'Incorrect Password'}));

        }
        else
            next();

    });

    app.use(compress());
    app.use('/static', express.static('website/static'));

    app.use(function(err, req, res, next){
        
        res.send(500, 'Something broke!');
    });

    try {
        app.listen(portalConfig.website.port, portalConfig.website.host, function () {
            logger.debug(logSystem, 'Server', 'Website started on ' + portalConfig.website.host + ':' + portalConfig.website.port);
        });
    }
    catch(e){
        logger.error(logSystem, 'Server', 'Could not start website on ' + portalConfig.website.host + ':' + portalConfig.website.port
            +  ' - its either in use or you do not have permission');
    }


};
