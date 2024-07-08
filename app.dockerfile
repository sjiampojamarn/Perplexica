FROM node:alpine

WORKDIR /home/perplexica

COPY ui /home/perplexica/

RUN yarn install
RUN yarn build

CMD ["yarn", "start"]
