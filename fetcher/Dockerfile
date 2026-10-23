FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
ENV HOST=0.0.0.0 PORT=8790
EXPOSE 8790
CMD ["python", "app.py"]
