# Node + Chrome (Chrome for Testing) for Selenium on Railway
# Explicit platform for Railway (linux/amd64)
FROM --platform=linux/amd64 node:20-bookworm-slim

# Chrome for Testing: matching Chrome + ChromeDriver (no version mismatch)
ARG CHROME_VERSION=145.0.7632.26
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    unzip \
    wget \
    && wget -q "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" -O /tmp/chrome.zip \
    && unzip -o /tmp/chrome.zip -d /tmp \
    && mv /tmp/chrome-linux64/chrome /usr/local/bin/ \
    && chmod +x /usr/local/bin/chrome \
    && wget -q "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chromedriver-linux64.zip" -O /tmp/chromedriver.zip \
    && unzip -o /tmp/chromedriver.zip -d /tmp \
    && mv /tmp/chromedriver-linux64/chromedriver /usr/local/bin/ \
    && chmod +x /usr/local/bin/chromedriver \
    && rm -rf /var/lib/apt/lists/* /tmp/chrome.zip /tmp/chromedriver.zip /tmp/chrome-linux64 /tmp/chromedriver-linux64

ENV CHROME_BIN=/usr/local/bin/chrome
ENV CHROMEDRIVER_PATH=/usr/local/bin/chromedriver

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
