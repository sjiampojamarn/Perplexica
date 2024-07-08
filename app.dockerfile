FROM node:alpine

WORKDIR /home/perplexica

COPY ui /home/perplexica/

RUN yarn install
RUN yarn build

ENTRYPOINT ["/bin/sh", "-c", "yarn build && yarn start"]
