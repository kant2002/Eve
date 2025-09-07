FROM node:24-alpine
LABEL MAINTAINER="Andrii Kurdiumov <kant2002@gmail.com>"
WORKDIR /eve
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN chmod +x ./node_modules/.bin/tsc
RUN npx tsc
ENV HOME /eve
ENV NODE_ENV=production
EXPOSE 8080
CMD npm start