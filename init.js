const fs = require('fs');
const path = require('path');
const os = require('os');
const cluster = require('cluster');
const async = require('async');
const extend = require('extend');

const PoolLogger = require('./libs/logging/logger.js');
const CliListener = require('./libs/cliListener.js');
const PoolWorker = require('./libs/poolWorker.js');
const PaymentProcessor = require('./libs/paymentProcessor.js');
const Website = require('./libs/website.js');
const ProfitSwitch = require('./libs/profitSwitch.js');

const algos = require('stratum-pool/lib/algos.js');

if (!fs.existsSync('config.json')) {
    console.log('config.json file does not exist. Read the installation/setup instructions.');
    return
}

const portalConfig = JSON.parse(fs.readFileSync("config.json", {encoding: 'utf8'}));
let poolConfigs;


const logger = new PoolLogger({
    logLevel: portalConfig.logLevel,
    logColors: portalConfig.logColors
});


try {
    require('newrelic');
    if (cluster.isMaster)
        logger.debug('NewRelic', 'Monitor', 'New Relic initiated')
} catch (e) {
}


//Try to give process ability to handle 100k concurrent connections
try {
    const posix = require('posix');
    try {
        posix.setrlimit('nofile', {soft: 100000, hard: 100000})
    }
    catch (e) {
        if (cluster.isMaster)
            logger.warning('POSIX', 'Connection Limit', '(Safe to ignore) Must be ran as root to increase resource limits')
    }
    finally {
        // Find out which user used sudo through the environment variable
        const uid = parseInt(process.env.SUDO_UID);
        // Set our server's uid to that user
        if (uid) {
            process.setuid(uid);
            logger.debug('POSIX', 'Connection Limit', 'Raised to 100K concurrent connections, now running as non-root user: ' + process.getuid())
        }
    }
}
catch (e) {
    if (cluster.isMaster)
        logger.debug('POSIX', 'Connection Limit', '(Safe to ignore) POSIX module not installed and resource (connection) limit was not raised')
}


if (cluster.isWorker) {

    switch (process.env.workerType) {
        case 'pool':
            new PoolWorker(logger);
            break;
        case 'paymentProcessor':
            new PaymentProcessor(logger);
            break;
        case 'website':
            new Website(logger);
            break;
        case 'profitSwitch':
            new ProfitSwitch(logger);
            break
    }

    return
}


//Read all pool configs from pool_configs and join them with their coin profile
const buildPoolConfigs = function () {
    const configs = {};
    const configDir = 'pool_configs/';

    const poolConfigFiles = [];


    /* Get filenames of pool config json files that are enabled */
    fs.readdirSync(configDir).forEach(function (file) {
        if (!fs.existsSync(configDir + file) || path.extname(configDir + file) !== '.json')
            return;
        const poolOptions = JSON.parse(fs.readFileSync(configDir + file, {encoding: 'utf8'}));
        if (!poolOptions.enabled)
            return;
        poolOptions.fileName = file;
        poolConfigFiles.push(poolOptions)
    });


    /* Ensure no pool uses any of the same ports as another pool */
    for (let i = 0; i < poolConfigFiles.length; i++) {
        const ports = Object.keys(poolConfigFiles[i].ports);
        for (let f = 0; f < poolConfigFiles.length; f++) {
            if (f === i) continue;
            const portsF = Object.keys(poolConfigFiles[f].ports);
            for (let g = 0; g < portsF.length; g++) {
                if (ports.indexOf(portsF[g]) !== -1) {
                    logger.error('Master', poolConfigFiles[f].fileName, 'Has same configured port of ' + portsF[g] + ' as ' + poolConfigFiles[i].fileName);
                    process.exit(1);
                    return
                }
            }

            if (poolConfigFiles[f].coin === poolConfigFiles[i].coin) {
                logger.error('Master', poolConfigFiles[f].fileName, 'Pool has same configured coin file coins/' + poolConfigFiles[f].coin + ' as ' + poolConfigFiles[i].fileName + ' pool');
                process.exit(1);
                return
            }

        }
    }


    poolConfigFiles.forEach(function (poolOptions) {

        poolOptions.coinFileName = poolOptions.coin;

        const coinFilePath = 'coins/' + poolOptions.coinFileName;
        if (!fs.existsSync(coinFilePath)) {
            logger.error('Master', poolOptions.coinFileName, 'could not find file: ' + coinFilePath);
            return
        }

        const coinProfile = JSON.parse(fs.readFileSync(coinFilePath, {encoding: 'utf8'}));
        poolOptions.coin = coinProfile;
        poolOptions.coin.name = poolOptions.coin.name.toLowerCase();

        if (poolOptions.coin.name in configs) {

            logger.error('Master', poolOptions.fileName, 'coins/' + poolOptions.coinFileName
                + ' has same configured coin name ' + poolOptions.coin.name + ' as coins/'
                + configs[poolOptions.coin.name].coinFileName + ' used by pool config '
                + configs[poolOptions.coin.name].fileName);

            process.exit(1);
            return
        }

        for (let option in portalConfig.defaultPoolConfigs) {
            if (!(option in poolOptions)) {
                const toCloneOption = portalConfig.defaultPoolConfigs[option];
                let clonedOption = {};
                if (toCloneOption.constructor === Object)
                    extend(true, clonedOption, toCloneOption);
                else
                    clonedOption = toCloneOption;
                poolOptions[option] = clonedOption
            }
        }


        configs[poolOptions.coin.name] = poolOptions;

        if (!(coinProfile.algorithm in algos)) {
            logger.error('Master', coinProfile.name, 'Cannot run a pool for unsupported algorithm "' + coinProfile.algorithm + '"');
            delete configs[poolOptions.coin.name]
        }

    });
    return configs
};


const spawnPoolWorkers = function () {

    Object.keys(poolConfigs).forEach(function (coin) {
        const p = poolConfigs[coin];

        if (!Array.isArray(p.daemons) || p.daemons.length < 1) {
            logger.error('Master', coin, 'No daemons configured so a pool cannot be started for this coin.');
            delete poolConfigs[coin]
        }
    });

    if (Object.keys(poolConfigs).length === 0) {
        logger.warning('Master', 'PoolSpawner', 'No pool configs exists or are enabled in pool_configs folder. No pools spawned.');
        return
    }


    const serializedConfigs = JSON.stringify(poolConfigs);

    const numForks = (function () {
        if (!portalConfig.clustering || !portalConfig.clustering.enabled)
            return 1;
        if (portalConfig.clustering.forks === 'auto')
            return os.cpus().length;
        if (!portalConfig.clustering.forks || isNaN(portalConfig.clustering.forks))
            return 1;
        return portalConfig.clustering.forks
    })();

    const poolWorkers = {};

    const createPoolWorker = function (forkId) {
        const worker = cluster.fork({
            workerType: 'pool',
            forkId: forkId,
            pools: serializedConfigs,
            portalConfig: JSON.stringify(portalConfig)
        });
        worker.forkId = forkId;
        worker.type = 'pool';
        poolWorkers[forkId] = worker;
        worker.on('exit', function (code, signal) {
            logger.error('Master', 'PoolSpawner', 'Fork ' + forkId + ' died, spawning replacement worker...');
            setTimeout(function () {
                createPoolWorker(forkId)
            }, 2000)
        }).on('message', function (msg) {
            switch (msg.type) {
                case 'banIP':
                    Object.keys(cluster.workers).forEach(function (id) {
                        if (cluster.workers[id].type === 'pool') {
                            cluster.workers[id].send({type: 'banIP', ip: msg.ip})
                        }
                    });
                    break
            }
        })
    };

    let i = 0;
    const spawnInterval = setInterval(function () {
        createPoolWorker(i);
        i++;
        if (i === numForks) {
            clearInterval(spawnInterval);
            logger.debug('Master', 'PoolSpawner', 'Spawned ' + Object.keys(poolConfigs).length + ' pool(s) on ' + numForks + ' thread(s)')
        }
    }, 250);

};


const processCoinSwitchCommand = function (params, options, reply) {

    const logSystem = 'CLI';
    const logComponent = 'coinswitch';

    const replyError = function (msg) {
        reply(msg);
        logger.error(logSystem, logComponent, msg)
    };

    if (!params[0]) {
        replyError('Coin name required');
        return
    }

    if (!params[1] && !options.algorithm) {
        replyError('If switch key is not provided then algorithm options must be specified');
        return
    }
    else if (params[1] && !portalConfig.switching[params[1]]) {
        replyError('Switch key not recognized: ' + params[1]);
        return
    }
    else if (options.algorithm && !Object.keys(portalConfig.switching).filter(function (s) {
            return portalConfig.switching[s].algorithm === options.algorithm
        })[0]) {
        replyError('No switching options contain the algorithm ' + options.algorithm);
        return
    }

    const messageCoin = params[0].toLowerCase();
    let newCoin = Object.keys(poolConfigs).filter(function (p) {
        return p.toLowerCase() === messageCoin
    })[0];

    if (!newCoin) {
        replyError('Switch message to coin that is not recognized: ' + messageCoin);
        return
    }


    const switchNames = [];

    if (params[1]) {
        switchNames.push(params[1])
    }
    else {
        for (const name in portalConfig.switching) {
            if (portalConfig.switching[name].enabled && portalConfig.switching[name].algorithm === options.algorithm)
                switchNames.push(name)
        }
    }

    switchNames.forEach(function (name) {
        if (poolConfigs[newCoin].coin.algorithm !== portalConfig.switching[name].algorithm) {
            replyError('Cannot switch a '
                + portalConfig.switching[name].algorithm
                + ' algo pool to coin ' + newCoin + ' with ' + poolConfigs[newCoin].coin.algorithm + ' algo');
            return
        }

        Object.keys(cluster.workers).forEach(function (id) {
            cluster.workers[id].send({type: 'coinswitch', coin: newCoin, switchName: name})
        })
    });

    reply('Switch message sent to pool workers')

};
const startCliListener = function () {

    const cliPort = portalConfig.cliPort;

    const listener = new CliListener(cliPort);
    listener.on('log', function (text) {
        logger.debug('Master', 'CLI', text)
    }).on('command', function (command, params, options, reply) {

        switch (command) {
            case 'blocknotify':
                Object.keys(cluster.workers).forEach(function (id) {
                    cluster.workers[id].send({type: 'blocknotify', coin: params[0], hash: params[1]})
                });
                reply('Pool workers notified');
                break;
            case 'coinswitch':
                processCoinSwitchCommand(params, options, reply);
                break;
            case 'reloadpool':
                Object.keys(cluster.workers).forEach(function (id) {
                    cluster.workers[id].send({type: 'reloadpool', coin: params[0]})
                });
                reply('reloaded pool ' + params[0]);
                break;
            default:
                reply('unrecognized command "' + command + '"');
                break
        }
    }).start()
};


const startPaymentProcessor = function () {

    let enabledForAny = false;
    for (let pool in poolConfigs) {
        const p = poolConfigs[pool];
        const enabled = p.enabled && p.paymentProcessing && p.paymentProcessing.enabled;
        if (enabled) {
            enabledForAny = true;
            break
        }
    }

    if (!enabledForAny)
        return;

    const worker = cluster.fork({
        workerType: 'paymentProcessor',
        pools: JSON.stringify(poolConfigs)
    });
    worker.on('exit', function (code, signal) {
        logger.error('Master', 'Payment Processor', 'Payment processor died, spawning replacement...');
        setTimeout(function () {
            startPaymentProcessor(poolConfigs)
        }, 2000)
    })
};


const startWebsite = function () {

    if (!portalConfig.website.enabled) return;

    const worker = cluster.fork({
        workerType: 'website',
        pools: JSON.stringify(poolConfigs),
        portalConfig: JSON.stringify(portalConfig)
    });
    worker.on('exit', function (code, signal) {
        logger.error('Master', 'Website', 'Website process died, spawning replacement...');
        setTimeout(function () {
            startWebsite(portalConfig, poolConfigs)
        }, 2000)
    })
};


const startProfitSwitch = function () {

    if (!portalConfig.profitSwitch || !portalConfig.profitSwitch.enabled) {
        //logger.error('Master', 'Profit', 'Profit auto switching disabled')
        return
    }

    const worker = cluster.fork({
        workerType: 'profitSwitch',
        pools: JSON.stringify(poolConfigs),
        portalConfig: JSON.stringify(portalConfig)
    });
    worker.on('exit', function (code, signal) {
        logger.error('Master', 'Profit', 'Profit switching process died, spawning replacement...');
        setTimeout(function () {
            startWebsite(portalConfig, poolConfigs)
        }, 2000)
    })
};


//Aion Testing - Remove website, profit switch and payment processor for solo mining testing
//To be restored in later versions
(() => {
    poolConfigs = buildPoolConfigs();
    spawnPoolWorkers();
    startPaymentProcessor();
    startWebsite();
    // startProfitSwitch()
    startCliListener();
})();
