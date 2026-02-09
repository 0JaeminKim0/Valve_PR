FROM node:20-slim

WORKDIR /app

# 패키지 파일 복사 및 설치
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# 소스 복사
COPY . .

# 포트 설정
EXPOSE 3000

# 실행
CMD ["npx", "tsx", "src/index.ts"]
