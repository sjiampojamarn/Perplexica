FROM node:20.18.0-alpine

RUN apk add --no-cache bash

WORKDIR /home/perplexica

COPY ui /home/perplexica/

RUN yarn install --frozen-lockfile
RUN yarn build

COPY replace-variables.sh /home/perplexica/replace-variables.sh
RUN chmod 755 /home/perplexica/replace-variables.sh

ENTRYPOINT ["/bin/sh", "-c", "/home/perplexica/replace-variables.sh && yarn start"]
