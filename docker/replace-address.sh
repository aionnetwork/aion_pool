#!/bin/bash
addr="$(ls /opt/aion/keystore/ | tail -1 | cut -d 'Z' -f2 | cut -d '-' -f3)"
sed -i "s/<<localaddr>>/0x$addr/" /opt/aion_pool/pool_configs/aion.json