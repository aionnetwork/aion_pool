let Web3 = require('aion-web3');
let web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:8545"));
const spawn = require('child_process').spawn;
const fs = require('fs');
const assert = require('assert');
const Cleanup = require('../cleanup');

//we need to keep references so we will kill them at exit
let miningPoolProcesses;
let minerProcess1;
let minerProcess2;
let dockerComposeUpCommand = "docker-compose -f test-mining-pools.yml up -d";
let dockerComposeDownCommand = "docker-compose -f test-mining-pools.yml down";

let startMiningPools = () => {
    miningPoolProcesses = spawn(testConfig.dockerComposeLocation + dockerComposeUpCommand, [], {detached: true});

    miningPoolProcesses.on('error', function(err){
        console.log(err);
    });
};

let startMiners = () => {
    //start first miner
    let argument1 = ["-t", testConfig.miner1Threads, "-u", testConfig.miner1];
    minerProcess1 = spawn(testConfig.aionminerCpuLocation, argument1, { detached: true});

    minerProcess1.on('error', function(err){
        console.log(err);
    });

    //start second miner
    let argument2 = ["-t", testConfig.miner1Threads, "-u", testConfig.miner1];
    minerProcess2 = spawn(testConfig.aionminerCpuLocation, [argument2], { detached: true});

    minerProcess2.on('error', function(err){
        console.log(err);
    });
};

// startMiningPools();
// startMiners();

let cleanupFunction = () => {
    console.log('cleaning up the processes');
    minerProcess1.kill();
    minerProcess2.kill();
    spawn(testConfig.dockerComposeLocation + dockerComposeDownCommand, [], {detached: true});
    process.exit();
};

Cleanup(cleanupFunction());