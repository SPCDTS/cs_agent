# 官方镜像自带 SQLite 3.34，读不了 pi-durable 的 STRICT 表（需 ≥3.37）；Datasette 检测到 pysqlite3 时优先用它。
FROM datasetteproject/datasette:0.65.1
RUN pip install --no-cache-dir pysqlite3-binary==0.5.4.post2
