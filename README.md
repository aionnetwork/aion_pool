# Aion Solo Mining Pool

## About

This is an Aion mining pool designed to be used in conjunction with the Aion mining client to be used on the Aion testnet. This mining pool has been specifically designed to be used only for solo mining on the Aion test network; it is not suitable to be used as a public mining pool and should not be deployed in that configuration.

## Quick start guide 

### Requirements (quickstart)
- **Aion kernel** ([download and install](https://github.com/aionnetwork/aion))
- **Python v2.7**
  - Included by default with Ubuntu desktop, may need to be installed seperatly in Ubuntu server. 
  - To install: ```sudo apt-get update && sudo apt-get install build-essential```
- **make** (Included with Ubuntu)
  - Included by default with Ubuntu desktop, may need to be installed seperatly in Ubuntu server. 
  - To install: ```sudo apt-get install python2.7 python-dev```

### Debug

In order to debug locally, insert $NODE_DEBUG_OPTION in *scripts* in package.json (result init.js run would look like: node $NODE_DEBUG_OPTION init.js)

> When debugging locally, make sure you start redis before hand (./redis/src/redis-server --daemonize yes)

### Instructions

- Open 2 terminal windows; using the first window navigate to your Aion kernel.
- Open the Aion configuration located in config/config.xml
- Disable kernel mining.
- Set the miner address to the address which will receive mined block rewards. The address is a 64 character (32 byte) hex string containing the public key and address of an account. 

  Eg.
  ```
    <consensus>
            <mining>false</mining>
            <miner-address>4cfb91f3053ee1b87ac5a7a1d9de0f5a14b71b642ae1d872f70794970f09a5a2</miner-address>
            <cpu-mine-threads>8</cpu-mine-threads>
            <extra-data>AION</extra-data>
    </consensus>
  ```

- Download the latest prepackaged aion_solo_pool on the ([release](https://github.com/aionnetwork/aion_miner/releases)) page.
- Place the download into the directory from which you plan to run the pool.
- Using the 2nd terminal window, navigate to the download directory and Unpack the solo pool.
  ```
  tar xf aion-solo-pool-<VERSION>.tar.gz
  ```
- Run the configure script; this script will download and build all of the pool dependencies and place them into the current directory. This script may take several minutes to complete however it must only be run once. 
  ```
  ./configure.sh
  ```
- Run the solo_pool using the quickstart run script. This script will start and stop both the pool and redis server. 
  ```
  ./run_quickstart.sh
  ```
- Start the Aion kernel in the first terminal window. 
- The pool is now ready to accept incoming client connections and to distribute work to clients. 


## Requirements (building from source)
* **Aion kernel** ([download and install](https://github.com/aionnetwork/aion))
* **Node.js** v8.9.3+ ([download and install](https://nodejs.org/en/download/))
* **Redis** key-value store v2.6+ ([download and install](http://redis.io/topics/quickstart))
* **Python v2.7**
* **make**
* **node-gyp** v3.6.2+ ([download and install](https://github.com/nodejs/node-gyp))

## Setup

#### 0) Setting up Aion (Optional)

The default Aion IP and port binding values are 127.0.0.1 (localhost) port 8545. These values may be changed by modify the following lines within the config/config.xml file located within the Aion kernel install folder. The IP and port bindings may be set to desired values; however this guide will assume a default binding of 127.0.0.1:8545.

```
<api>
        <rpc active="true" ip="127.0.0.1" port="8545"></rpc>
        ....
</api>
```

#### 1) Clone the repository locally

```git clone https://github.com/aionnetwork/aion_miner.git```

#### 2) Verify the pool has been correctly configured for the Aion RPC connections
- Navigate to the pool_configs folder and open aion.json.
- Scroll to the ```daemons``` section.
- Ensure the daemon configuration matches the Aion IP and port binding from the previous step. 

Eg. Using default settings the configuration should be:

```
    "daemons": [
        {
            "host": "127.0.0.1",
            "port": 8545,
            "user": "",
            "password": ""
        }
    ]
```

#### 3) Install node modules

- Navigate to the root of the pool directory.
- Run the command 
```
npm install
``` 
and allow all required npm modules to be installed in the node_modules folder.

#### 4) Verify the equihash verifier build

- Navigate to ```local_modules/equihashverify```
- Run test with the following command 
```
node test.js
```
- A successful test should output: 
```
Header length: 528
Solution length: 1408
true
```

**Note:**

The test may fail if libsodium was installed during the solo pool setup, to resolve this attempt to reconfigure to dynamic linker using 
    ```
    sudo ldconfig -v
    ```
    Rebuild the verifier using the command 
    ```
    node-gyp rebuild
    ``` 
    and then repeating the test.


#### 5) Start Redis Server

- Navigate to the Redis install folder.
- Start the Redis server ```(./src/redis-server)``` from the root of the redis install folder. 

#### 6) Verify Aion configuration
- Open the Aion config in the root Aion folder /config/config.xml.
- Navigate to the consensus section.
- Disable kernel mining.
- Set the miner address to the address which will receive mined block rewards. The address is a 64 character (32 byte) hex string containing the public key and address of an account. 

Eg.

```
<consensus>
        <mining>false</mining>
        <miner-address>4cfb91f3053ee1b87ac5a7a1d9de0f5a14b71b642ae1d872f70794970f09a5a2</miner-address>
        <cpu-mine-threads>8</cpu-mine-threads>
        <extra-data>AION</extra-data>
</consensus>
```

- Enable "stratum" RPC methods by adding in the list ```<apis-enabled>``` 

Eg.

```
<apis-enabled>web3,eth,personal,stratum</apis-enabled>
```

#### 7) Start the Aion kernel

- Navigate to the aion install folder
- Start the kernel ```./aion.sh```

#### 8) Start the mining pool

- Navigate to the base mining pool folder
- Start the mining pool ```./run.sh```
- Ensure the pool starts with no error messages.

At this stage the mining pool is ready to receive client connections and to distribute work. 

#### 9) Validate client connections (Optional)

- The pool is configured to listen for client connections on port 3333 by default. This may be changed in the config.json file located in the root of the pool folder. 
- Connect one of the solo mining clients to the pool using a location of **127.0.0.1:3333**. 
- Once connected the client should begin receiving work within several seconds; if receiving work the pool has been successfully configured.

## Wallet type recommendation 

### Miner

As a miner the following possibilities can be taken into account:
* personal hot wallet -  if mining for the purpose of staking/hodling the coins short or medium term, the miner can use 
a personal wallet like: Jaxx, Exodus, Coinbase, etc.
* exchange - if mining for the purpose of automatically selling the coins the best options is to use an exchange and 
directly sell your coins
* cold wallet - if mining for the purpose of staking/hodling the coins long term, the miner's best choice is the use of 
a cold wallet
    * paper wallet  
    * trezor
    * ledger
    * keepkey

### Mining pool operator

As a mining pool operator the used addresses can be split into 2 categories:
* the mining pool main address - this is the address which will be used by the pool to get the coins into and will later
be used to execute the payments from
* the mining pool operator addres(ses) - these are the addresses belonging to the actual pool operator. This address is 
used to send the pool fees into during the payment processing. This can be configured in pool_configs/aion.json under "rewardRecipients".

> The same ideas like from the miner apply when choosing the mining pool operator address(ses) type.

License
-------
Released under the GNU General Public License v2

http://www.gnu.org/licenses/gpl-2.0.html
