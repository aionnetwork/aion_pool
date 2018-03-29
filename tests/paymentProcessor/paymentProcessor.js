let Web3 = require('aion-web3');
let web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:8545"));
const spawn = require('child_process').spawn;
const fs = require('fs');
const assert = require('assert');
const Cleanup = require('./cleanup');

const testConfig = JSON.parse(fs.readFileSync('../testConfig.json', 'utf-8'));
let subprocess1;
let subprocess2;

let startBothMiners = () => {
    //start first miner
    let argument1 = ["-t", testConfig.miner1Threads, "-u", testConfig.miner1];
    subprocess1 = spawn(testConfig.aionminerCpuLocation, argument1, { detached: true});

    subprocess1.on('error', function(err){
        console.log(err);
    });

    //start second miner
    let argument2 = "-t " + testConfig.miner2Threads + " -u " + testConfig.miner2;
    subprocess2 = spawn(testConfig.aionminerCpuLocation, [argument2], { detached: true});

    subprocess2.on('error', function(err){
        console.log(err);
    });
};

let verifyBothMinersGetPaidFromTimeToTime = () => {
    let balanceMiner1 = readMinersBalanceToWei(testConfig.miner1);
    let balanceMiner2 = readMinersBalanceToWei(testConfig.miner2);

    assert.notEqual(miner1StartBalance, balanceMiner1);
    assert.notEqual(miner2StartBalance, balanceMiner2);
};

let readMinersBalanceToWei = (address) => {
    let bigNum = web3.eth.getBalance(address);
    return web3.fromWei(bigNum).toString();
};

let miner1StartBalance = readMinersBalanceToWei(testConfig.miner1);
let miner2StartBalance = readMinersBalanceToWei(testConfig.miner2);
console.log('Starting balance for miner 1: ', miner1StartBalance);
console.log('Starting balance for miner 2: ', miner2StartBalance);

startBothMiners();
setTimeout(verifyBothMinersGetPaidFromTimeToTime, 180000);

let cleanupFunction = () => {
    console.log('cleaning up the processes');
    subprocess1.kill();
    subprocess1.kill();
    process.exit();
};

Cleanup(cleanupFunction);