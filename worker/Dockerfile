# syntax=docker/dockerfile:1.7
FROM python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app \
    EXTREME_ML_MODEL_DIR=/opt/extreme/models \
    EXTREME_STORAGE_ROOT=/var/data \
    XDG_DATA_HOME=/var/data/cache \
    HOME=/var/data/home \
    HF_HUB_OFFLINE=1 \
    OMP_NUM_THREADS=1 \
    MALLOC_ARENA_MAX=2

RUN groupadd --gid 10001 extreme \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /var/data/home --shell /usr/sbin/nologin extreme \
    && mkdir -p /app /opt/extreme/models /opt/extreme/licenses /var/data/cache /var/data/home \
    && chown -R extreme:extreme /var/data

WORKDIR /app

COPY requirements-production.txt /app/requirements-production.txt
RUN python -m pip install --no-cache-dir --require-hashes -r /app/requirements-production.txt

ADD --checksum=sha256:1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3 \
    https://raw.githubusercontent.com/snakers4/silero-vad/7e30209a3e901f9842f81b225f3e93d8199902b1/src/silero_vad/data/silero_vad.onnx \
    /opt/extreme/models/silero_vad_v6.2.1.onnx
ADD --checksum=sha256:269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd \
    https://huggingface.co/TigreGotico/dnsmos-onnx/resolve/27691a53aa069b27be6ac957013d43b3c442da9d/sig_bak_ovr.onnx \
    /opt/extreme/models/dnsmos_sig_bak_ovr.onnx
ADD --checksum=sha256:9246480c58567bc6affd4200938e77eef49468c8bc7ed3776d109c07456f6e91 \
    https://huggingface.co/TigreGotico/dnsmos-onnx/resolve/27691a53aa069b27be6ac957013d43b3c442da9d/model_v8.onnx \
    /opt/extreme/models/dnsmos_p808_model_v8.onnx
ADD --checksum=sha256:f939dcc1945055a435565b4369e27dafd0f87df3cea4e2ff6eb81225e52cc53b \
    https://huggingface.co/TigreGotico/sigmos-onnx/resolve/33ccd4fca5b8ffe03828530753f0b35769b8e880/model-sigmos_1697718653_41d092e8-epo-200.onnx \
    /opt/extreme/models/sigmos_p804.onnx
ADD --checksum=sha256:2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b \
    https://raw.githubusercontent.com/snakers4/silero-vad/7e30209a3e901f9842f81b225f3e93d8199902b1/LICENSE \
    /opt/extreme/licenses/silero-vad-LICENSE
ADD --checksum=sha256:5baa259ffd1a975780869d7d2925212224c92206cefb96fb2bf0b146650e5029 \
    https://huggingface.co/TigreGotico/dnsmos-onnx/resolve/27691a53aa069b27be6ac957013d43b3c442da9d/LICENSE.txt \
    /opt/extreme/licenses/dnsmos-LICENSE.txt
ADD --checksum=sha256:c075a7fdbcff0157cf50a2c2b54c7190e36e0215ec5b9145988fdd1f9efb869b \
    https://huggingface.co/TigreGotico/sigmos-onnx/resolve/33ccd4fca5b8ffe03828530753f0b35769b8e880/LICENSE.txt \
    /opt/extreme/licenses/sigmos-LICENSE.txt

COPY extreme_worker /app/extreme_worker

RUN chmod 0444 /opt/extreme/models/*.onnx /opt/extreme/licenses/* \
    && chmod -R a-w /app /opt/extreme

USER extreme
WORKDIR /var/data

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '10000') + '/health/live', timeout=3).close()"

CMD ["sh", "-c", "exec uvicorn extreme_worker.app:create_app --factory --host 0.0.0.0 --port \"${PORT:-10000}\" --workers 1 --no-access-log"]
