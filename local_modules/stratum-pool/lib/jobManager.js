const events = require('events');
const crypto = require('crypto');
const algos = require('./algos.js')
const bignum = require('bignum');


const util = require('./util.js');
const blockTemplate = require('./blockTemplate.js');


//Unique extranonce per subscriber
var ExtraNonceCounter = function(configInstanceId){

    if(typeof configInstanceId == 'undefined' && configInstanceId) {
        configInstanceId = crypto.randomBytes(4).readUInt32LE(0);
    }

    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = 0;

    this.next = function(){

        var buff = new Buffer(8);
        buff.writeUInt32BE(instanceId, 0);
        buff.writeUInt32BE(Math.abs(counter++), 4);
        return buff.toString('hex');

        // var extraNonce = util.packUInt32BE(Math.abs(counter++));
        // return extraNonce.toString('hex');
    };

    this.size = 8; //bytes
};

//Unique job per new block template
const JobCounter = function () {
    let counter = 0;

    this.next = function () {
        counter++;
        if (counter % 0xffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

function isHexString(s) {
    const check = String(s).toLowerCase();
    if (check.length % 2) {
        return false;
    }
    for (i = 0; i < check.length; i = i + 2) {
        const c = check[i] + check[i + 1];
        if (!isHex(c))
            return false;
    }
    return true;
}

function isHex(c) {
    const a = parseInt(c, 16);
    let b = a.toString(16).toLowerCase();
    if (b.length % 2) {
        b = '0' + b;
    }
    return b === c;
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
const JobManager = module.exports = function JobManager(options) {


    //private members

    const _this = this;
    const jobCounter = new JobCounter();

    const shareMultiplier = algos[options.coin.algorithm].multiplier;

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
    this.extraNoncePlaceholder = new Buffer('f000000ff111111f', 'hex');
    this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;

    this.currentJob;
    this.validJobs = {};

    const hashDigest = algos[options.coin.algorithm].hash(options.coin);

    const coinbaseHasher = (function () {
        switch (options.coin.algorithm) {
            case 'keccak':
            case 'blake':
            case 'fugue':
            case 'groestl':
                if (options.coin.normalHashing === true)
                    return util.sha256d;
                else
                    return util.sha256;
            default:
                return util.sha256d;
        }
    })();


    const blockHasher = (function () {
        switch (options.coin.algorithm) {
            case 'scrypt':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-og':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-jane':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-n':
            case 'sha1':
                return function (d) {
                    return util.reverseBuffer(util.sha256d(d));
                };
            default:
                return function () {
                    return util.reverseBuffer(hashDigest.apply(this, arguments));
                };
        }
    })();

    this.updateCurrentJob = function (rpcData) {

        const tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    };

    //returns true if processed a new block
    this.processTemplate = function (rpcData) {

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
           block height is greater than the one we have */
        let isNewBlock = typeof(_this.currentJob) === 'undefined';

        if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height) {
                return false;
            }
        }

        if (!isNewBlock) {
            return false;
        }

        const tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    };

    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln) {

        const shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return {error: error, result: null};
        };

        const submitTime = Date.now() / 1000 | 0;

        let job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId) {
            return shareError([21, 'job not found']);
        }

        if (nTime.length !== 16) {
            return shareError([20, 'incorrect size of ntime']);
        }

        if (nonce.length !== 64) {
            return shareError([20, 'incorrect size of nonce']);
        }

        // 2816 solution length (1408 * 2 for hex) + 3 bytes buffer header
        if (soln.length !== 2822) {
            return shareError([20, 'incorrect size of solution']);
        }

        if (!isHexString(extraNonce2)) {
            return shareError([20, 'invalid hex in extraNonce2']);
        }

        if (!job.registerSubmit(extraNonce1.toLowerCase(), extraNonce2.toLowerCase(), nTime, nonce)) {
            return shareError([22, 'duplicate share']);
        }

        const extraNonce1Buffer = new Buffer(extraNonce1, 'hex');
        const extraNonce2Buffer = new Buffer(extraNonce2, 'hex');

        const headerBuffer = job.serializeHeader("root", nTime, nonce); // 528 bytes (doesn't contain soln)
        const headerSolnBuffer = new Buffer.concat([headerBuffer, new Buffer(soln.slice(6), 'hex')]);

        //Change to Blake2b
        const headerHash = util.blake2(32, headerSolnBuffer);
        const headerBigNum = bignum.fromBuffer(headerHash, {endian: 'big', size: 32});

        let blockHashInvalid;
        let blockHash;
        let blockHex;

        const shareDiff = blockTemplate.diff1 / headerBigNum.toNumber() * shareMultiplier;
        const blockDiffAdjusted = job.difficulty * shareMultiplier;

        // check if valid Equihash solution
        if (hashDigest(headerBuffer, new Buffer(soln.slice(6), 'hex')) !== true) {
            return shareError([20, 'invalid solution']);
        }

        // check if solution meets target
        const completeHeader = job.serializeHeaderTarget(nonce, soln, nTime);
        const completeHeaderHash = new Buffer(util.blake2(32, completeHeader), 'hex');

        const completeHeaderBigNum = bignum.fromBuffer(completeHeaderHash, {endian: 'big', size: 32});

        if (completeHeaderBigNum.gt(job.target)) {
            return shareError([20, 'Header hash larger than target']);
        }

        //TODO: Bring this back after share diff adjustment is re-implemented
        // //check if block candidate
        // if (headerBigNum.le(job.target)) {
        //     blockHex = job.serializeBlock(headerBuffer, new Buffer(soln, 'hex')).toString('hex');
        //     blockHash = util.reverseBuffer(headerHash).toString('hex');
        // }
        // else {
        //     if (options.emitInvalidBlockHashes)
        //         blockHashInvalid = util.reverseBuffer(util.sha256d(headerSolnBuffer)).toString('hex');

        //     //Check if share didn't reached the miner's difficulty)
        //     if (shareDiff / difficulty < 0.99) {

        //         //Check if share matched a previous difficulty from before a vardiff retarget
        //         if (previousDifficulty && shareDiff >= previousDifficulty) {
        //             difficulty = previousDifficulty;
        //         }
        //         else {
        //             return shareError([23, 'low difficulty share of ' + shareDiff]);
        //         }

        //     }
        // }

        blockHash = util.reverseBuffer(headerHash).toString('hex');

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: getBlockReward(job.rpcData.height),
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: completeHeaderHash.toString('hex'),
            blockHashInvalid: blockHashInvalid,
            headerHash: job.rpcData.headerHash
        }, nTime, nonce, new Buffer(soln.slice(6), 'hex').toString('hex'), job.headerHash);

        return {result: true, error: null, blockHash: blockHash};
    };

    let getBlockReward = function (blockNumber) {
        const blockReward = 1497989283243310185;
        const magnitude = 1000000000000000000;
        const rampUpLowerBound = 0;
        const rampUpUpperBound = 259200;
        const rampUpStartValue = 748994641621655092;
        const rampUpEndValue = blockReward;

        const delta = rampUpUpperBound - rampUpLowerBound;
        const m = (rampUpEndValue - rampUpStartValue) / delta;

        if (blockNumber <= rampUpUpperBound) {
            return ((m * blockNumber) + rampUpStartValue) / magnitude;
        } else {
            return blockReward / magnitude;
        }
    }
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
