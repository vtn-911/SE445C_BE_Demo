class MappingApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str, response_body=None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.response_body = response_body

    def to_response(self):
        if self.response_body is not None:
            return self.response_body
        return {
            "status": "error",
            "error": {"code": self.code, "message": self.message},
        }


class MappingRequestError(MappingApiError):
    def __init__(self, code: str, message: str):
        super().__init__(400, code, message)


class MappingPayloadTooLargeError(MappingApiError):
    def __init__(self):
        super().__init__(413, "PAYLOAD_TOO_LARGE", "Mapping request exceeds the size limit")


class MappingNeedsReviewError(MappingApiError):
    def __init__(
        self,
        mapping,
        unmapped_fields,
        warnings,
        confidence="low",
    ):
        super().__init__(
            422,
            "MAPPING_NEEDS_REVIEW",
            "The source data could not be mapped confidently",
            {
                "status": "needsReview",
                "canonicalVersion": "Product-v1",
                "mapping": mapping,
                "confidence": confidence,
                "unmappedFields": unmapped_fields,
                "warnings": warnings,
            },
        )


class MappingServiceUnavailableError(MappingApiError):
    def __init__(self):
        super().__init__(
            503,
            "MAPPING_SERVICE_UNAVAILABLE",
            "The mapping service is not configured or available",
        )


class GeminiUnavailableError(MappingApiError):
    def __init__(self, code="GEMINI_UNAVAILABLE", message="Gemini is unavailable or not configured"):
        super().__init__(503, code, message)


class GeminiTimeoutError(MappingApiError):
    def __init__(self):
        super().__init__(504, "GEMINI_TIMEOUT", "Gemini did not respond before the timeout")
