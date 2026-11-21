import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from .errors import (
    MappingApiError,
    MappingPayloadTooLargeError,
    MappingRequestError,
)
from .gemini_client import GeminiMappingClient
from .models import MappingEnvelope
from .product_mapper import ProductMappingService
from .settings import MappingSettings


MAX_REQUEST_BYTES = 1_048_576


class DuplicateJsonKeyError(ValueError):
    pass


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKeyError("Duplicate JSON object key")
        result[key] = value
    return result


def _reject_non_finite_constant(_value):
    del _value
    raise ValueError("Non-finite JSON numbers are not allowed")


def decode_mapping_request(body):
    try:
        request_data = json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_finite_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, DuplicateJsonKeyError, ValueError):
        raise MappingRequestError("INVALID_REQUEST_JSON", "Request body must be valid JSON") from None

    try:
        envelope = MappingEnvelope.model_validate(request_data)
    except ValidationError:
        raise MappingRequestError(
            "INVALID_MAPPING_REQUEST",
            "Request must contain format and a matching JSON object or XML string payload",
        ) from None
    return envelope.format, envelope.payload


def create_app(mapping_service=None):
    if mapping_service is None:
        settings = MappingSettings.from_environment()
        proposal_client = GeminiMappingClient(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            timeout_ms=settings.gemini_timeout_ms,
        )
        mapping_service = ProductMappingService(proposal_client)

    app = FastAPI(title="ABC Retail AI Data Mapping Service", version="1.0.0")

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/api/v1/mapping/products")
    async def map_product(request: Request):
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            error = MappingRequestError(
                "UNSUPPORTED_CONTENT_TYPE",
                "Content-Type must be application/json",
            )
            return JSONResponse(status_code=error.status_code, content=error.to_response())

        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > MAX_REQUEST_BYTES:
                    error = MappingPayloadTooLargeError()
                    return JSONResponse(status_code=error.status_code, content=error.to_response())
            except ValueError:
                error = MappingRequestError("INVALID_CONTENT_LENGTH", "Content-Length is invalid")
                return JSONResponse(status_code=error.status_code, content=error.to_response())

        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_REQUEST_BYTES:
                error = MappingPayloadTooLargeError()
                return JSONResponse(status_code=error.status_code, content=error.to_response())

        try:
            format_name, payload = decode_mapping_request(bytes(body))
            result = await run_in_threadpool(mapping_service.map_product, format_name, payload)
            return JSONResponse(status_code=200, content=result)
        except MappingApiError as error:
            return JSONResponse(status_code=error.status_code, content=error.to_response())

    return app


app = create_app()
