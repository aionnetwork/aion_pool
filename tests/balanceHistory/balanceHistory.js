let Web3 = require('aion-web3');
let web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:8545"));
const spawn = require('child_process').spawn;
const Cleanup = require('../cleanup');
const fs = require('fs');
const testConfig = JSON.parse(fs.readFileSync('../testConfig.json', 'utf-8'));

let miner1Process;
let miner2Process;

let startMiners = () => {
    const miner1Args = ["-t", 2, "-u", testConfig.miner1];
    miner1Process = spawn(testConfig.aionminerCpuLocation, miner1Args, {detached: true});
    miner1Process.on('error', function (err) {
        console.log(err);
    });

    const miner2Args = ["-t", 1, "-u", testConfig.miner2];
    miner2Process = spawn(testConfig.aionminerCpuLocation, miner2Args, {detached: true});
    miner2Process.on('error', function (err) {
        console.log(err);
    });
};

let getAccountDetails = (address) => {
    const balance = web3.eth.getBalance(address);
    return (web3.fromWei(balance)).toString();
};

let printAccountsDetails = () => {
    const poolBalance = getAccountDetails(testConfig.poolAddress);
    const miner1Balance = getAccountDetails(testConfig.miner1);
    const miner2Balance = getAccountDetails(testConfig.miner2);
    const poolOpBalance = getAccountDetails(testConfig.poolOperatorAddress)
    console.log('Pool balance: ' + poolBalance);
    console.log('Miner 1 balance: ' + miner1Balance);
    console.log('Miner 2 balance ' + miner2Balance);
    console.log('Pool operator balance ' + poolOpBalance);
    console.log('-------------------------------------------------------------------------');
};

startMiners();
setInterval(function () {
    printAccountsDetails();
}, 30 * 1000);

let cleanupFunction = () => {
    console.log('cleaning up the processes');
    miner1Process.kill();
    miner2Process.kill();
    process.exit();
};

Cleanup(cleanupFunction);