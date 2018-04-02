FROM ubuntu:16.04

MAINTAINER "alin@centrys.io"

RUN apt-get -y update
RUN apt-get -y install software-properties-common python-software-properties lbzip2
RUN add-apt-repository ppa:webupd8team/java
RUN apt-get -y update
RUN echo oracle-java9-installer shared/accepted-oracle-license-v1-1 select true | debconf-set-selections && apt-get -y install oracle-java9-installer && apt-get -y install oracle-java9-set-default

RUN apt install wget && cd /opt/ \
    && wget https://github.com/aionnetwork/aion/releases/download/v0.1.18/aion-v0.1.18.42be2c7-2018-03-30.tar.bz2 -O aion.tar.bz2 \
    && ls \
    && tar -xf aion.tar.bz2

COPY config.xml /opt/aion/config/

EXPOSE 8545 19333

CMD ["/bin/bash", "/opt/aion/aion.sh"]