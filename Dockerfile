FROM python:3.11-slim

WORKDIR /app

# 시스템 의존성 설치
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Python 패키지 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 소스 복사
COPY . .

# 포트 설정
EXPOSE 3000

# 환경 변수
ENV PORT=3000
ENV PYTHONUNBUFFERED=1

# 실행
CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:3000", "--workers", "2", "--timeout", "120"]
