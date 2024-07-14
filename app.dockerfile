FROM node:alpine

RUN apk add --no-cache bash

# Set environment variable to disable telemetry
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /home/perplexica

COPY ui /home/perplexica/

RUN yarn install
RUN yarn build

COPY replace-variables.sh /home/perplexica/replace-variables.sh
RUN chmod 755 /home/perplexica/replace-variables.sh

ENTRYPOINT ["/bin/sh", "-c", "/home/perplexica/replace-variables.sh && yarn start"]
