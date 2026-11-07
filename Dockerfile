FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Asia/Seoul
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# Render는 PORT 환경변수를 넣어 줌 (기본 10000)
ENV PORT=10000
EXPOSE 10000
CMD ["python", "server.py"]
