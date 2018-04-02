# Testing documentation

## Testing the payment process

**Please check the required settings carefully before running so the tests will run correctly.**

### Requirements

* aion kernel running locally
* two addresses created (aion.sh -a create)
* put the addresses information in testConfig.json
* running a mining pool locally
* aionminer cpu
* input the aionminer cpu disk location in testConfig.json

#### Payment processor test

The payment processor test will take about 3 minutes to finish as it waits for block mining and transaction confirmation.

#### Mining pool testing

The mining pool testing will need two separate mining pools and configuring these locations in testConfig.json.
The reason for this is that we will use the mining pools on the same node to test if the pools can handle themselves when 
other pools are in the equation.

Both pools need to be configured (run configure.sh) to run on the same AION node.

