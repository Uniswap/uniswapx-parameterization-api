FROM node:16

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
WORKDIR /app

ARG NPM_TOKEN

COPY package*.json ./
COPY tsconfig.json ./
COPY src /app/src

RUN ls -a

EXPOSE 8080

RUN yarn && yarn build

CMD [ "node", "./dist/index.js" ]
