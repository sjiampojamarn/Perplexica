FROM node:lts-alpine

ARG NEXT_PUBLIC_WS_URL=BAKED_NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_API_URL=BAKED_NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN apk add --no-cache bash

# Set environment variable to disable telemetry
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /home/perplexica

COPY ui /home/perplexica/

RUN yarn config set registry https://registry.npmjs.org

RUN yarn install --frozen-lockfile
RUN yarn build

COPY replace-variables.sh /home/perplexica/replace-variables.sh
RUN chmod 755 /home/perplexica/replace-variables.sh

ENTRYPOINT ["/bin/sh", "-c", "/home/perplexica/replace-variables.sh && yarn start"]
