FROM ubuntu:16.04

MAINTAINER "alin@centrys.io"

RUN apt-get update && apt-get install -y wget git npm \
  && cd /opt/ \
  && git clone https://github.com/aionnetwork/aion_pool/ \
  && chmod 744 -R aion_pool/ \
  && cd ./aion_pool && git reset --hard && git fetch && git checkout development && git pull \
  && rm -rf ./redis.tar.gz ./node.tar.gz ./redis ./node \
  && wget http://download.redis.io/releases/redis-4.0.8.tar.gz -O ./redis.tar.gz \
  && wget https://nodejs.org/dist/v8.9.4/node-v8.9.4-linux-x64.tar.xz -O ./node.tar.gz \
  && tar -xf ./redis.tar.gz \
  && mv ./redis-4.0.8 ./redis \
  && tar -xf ./node.tar.gz \
  && mv ./node-v8.9.4-linux-x64 ./node \
  && make -C ./redis \
  && export PATH=$PATH:$PWD/node/bin \
  && npm install \
  && ./redis/src/redis-server --daemonize yes

EXPOSE 3008

WORKDIR /opt/aion_pool/

ENV PATH="${PATH}:/opt/aion_pool/node/bin"

COPY aion-config.json /opt/aion_pool/pool_configs/aion.json
COPY replace-address.sh /opt/aion_pool/pool_configs/

RUN chmod +x /opt/aion_pool/pool_configs/replace-address.sh

ENTRYPOINT /opt/aion_pool/pool_configs/replace-address.sh && /opt/aion_pool/run_quickstart.sh