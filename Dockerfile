FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    libjpeg-dev \
    libpng-dev \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

COPY . .

CMD ["node", "bot.js"]
