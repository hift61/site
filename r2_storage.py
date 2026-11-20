"""Private Cloudflare R2 video access with short-lived, object-scoped URLs."""
import os
from functools import lru_cache

from werkzeug.exceptions import BadGateway, Conflict, ServiceUnavailable

VARIABLES = ('R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
MAX_VIDEO_BYTES = 2_000_000_000


def configuration():
    return tuple(os.environ.get(name, '').strip() for name in VARIABLES)


def enabled():
    return all(configuration())


@lru_cache(maxsize=2)
def make_client(account, bucket, access_key, secret_key):
    import boto3
    from botocore.config import Config

    return boto3.client(
        's3',
        endpoint_url=f'https://{account}.r2.cloudflarestorage.com',
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name='auto',
        config=Config(signature_version='s3v4', s3={'addressing_style': 'path'},
                      request_checksum_calculation='when_required',
                      response_checksum_validation='when_required',
                      connect_timeout=4, read_timeout=8,
                      retries={'total_max_attempts': 2})
    )


def connection():
    values = configuration()
    if not all(values):
        raise ServiceUnavailable('영상 저장소 환경변수 설정을 확인하세요.')
    return make_client(*values), values[1]


def put_url(key, mime):
    client, bucket = connection()
    return client.generate_presigned_url(
        'put_object', Params={'Bucket': bucket, 'Key': key, 'ContentType': mime, 'IfNoneMatch': '*'},
        ExpiresIn=3600)


def get_url(key):
    client, bucket = connection()
    return client.generate_presigned_url('get_object', Params={'Bucket': bucket, 'Key': key}, ExpiresIn=3600)


def validate(key, expected_size, expected_mime):
    from botocore.exceptions import BotoCoreError, ClientError

    client, bucket = connection()
    try:
        result = client.head_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        if exc.response.get('ResponseMetadata', {}).get('HTTPStatusCode') == 404:
            raise Conflict('영상 전송이 완료되지 않았습니다. 다시 업로드해 주세요.') from exc
        raise BadGateway('R2 버킷 이름과 토큰의 읽기·쓰기 권한을 확인하세요.') from exc
    except BotoCoreError as exc:
        raise BadGateway('영상 저장소에 연결하지 못했습니다. 다시 시도해 주세요.') from exc

    if result.get('ContentLength') != expected_size or result.get('ContentType') != expected_mime:
        raise Conflict('저장된 영상의 용량 또는 형식이 원본 정보와 다릅니다.')
