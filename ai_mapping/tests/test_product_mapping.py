import importlib.util
import asyncio
import json
import socket
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from ai_mapping.app import create_app, decode_mapping_request
from ai_mapping.errors import (
    GeminiTimeoutError,
    GeminiUnavailableError,
    MappingNeedsReviewError,
    MappingRequestError,
)
from ai_mapping.gemini_client import GeminiMappingClient
from ai_mapping.models import MappingProposal
from ai_mapping.product_mapper import ProductMappingService
from ai_mapping.source_parser import flatten_json_payload, flatten_xml_payload


def expected_mappings():
    return [
        {"targetField": "sku", "sourcePath": "/ProductCode"},
        {"targetField": "name", "sourcePath": "/ProductName"},
        {"targetField": "category", "sourcePath": "/ProductCategory"},
        {"targetField": "price", "sourcePath": "/UnitPrice"},
    ]


def proposal(confidence="high", mappings=None, warnings=None):
    return {
        "mappings": expected_mappings() if mappings is None else mappings,
        "confidence": confidence,
        "warnings": [] if warnings is None else warnings,
    }


class FakeProposalClient:
    def __init__(self, value):
        self.value = value
        self.received_fields = None

    def propose(self, source_fields):
        self.received_fields = source_fields
        if isinstance(self.value, Exception):
            raise self.value
        return MappingProposal.model_validate(self.value)


class FakeMappingService:
    def __init__(self, response=None, error=None):
        self.calls = []
        self.error = error
        self.response = response or {
            "status": "success",
            "canonicalVersion": "Product-v1",
            "data": {
                "sku": "SKU-0001",
                "name": "Organic Apples 1",
                "category": "Fresh Produce",
                "price": 4.99,
            },
            "mapping": {
                "sku": "/ProductCode",
                "name": "/ProductName",
                "category": "/ProductCategory",
                "price": "/UnitPrice",
            },
            "confidence": "high",
            "warnings": [],
        }

    def map_product(self, format_name, payload):
        self.calls.append((format_name, payload))
        if self.error:
            raise self.error
        return self.response


def call_asgi(app, method, path, body, content_type="application/json"):
    async def invoke():
        messages = []
        request_sent = False
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "root_path": "",
            "headers": [
                (b"host", b"testserver"),
                (b"content-type", content_type.encode("ascii")),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
            "app": app,
        }

        async def receive():
            nonlocal request_sent
            if request_sent:
                return {"type": "http.disconnect"}
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(message):
            messages.append(message)

        await app(scope, receive, send)
        response_start = next(message for message in messages if message["type"] == "http.response.start")
        response_body = b"".join(
            message.get("body", b"")
            for message in messages
            if message["type"] == "http.response.body"
        )
        return response_start["status"], json.loads(response_body)

    return asyncio.run(invoke())


class MappingRequestTests(unittest.TestCase):
    def test_decodes_json_envelope(self):
        format_name, payload = decode_mapping_request(
            b'{"format":"json","payload":{"ProductCode":"SKU-0001"}}'
        )
        self.assertEqual(format_name, "json")
        self.assertEqual(payload, {"ProductCode": "SKU-0001"})

    def test_decodes_xml_envelope(self):
        xml = "<Product><ProductCode>SKU-0001</ProductCode></Product>"
        format_name, payload = decode_mapping_request(
            json.dumps({"format": "xml", "payload": xml}).encode()
        )
        self.assertEqual(format_name, "xml")
        self.assertEqual(payload, xml)

    def test_rejects_malformed_duplicate_and_invalid_envelopes(self):
        invalid_bodies = (
            b'{"format":"json","payload":',
            b'{"format":"json","format":"xml","payload":{}}',
            b'{"format":"yaml","payload":{}}',
            b'{"format":"json","payload":[]}',
            b'{"format":"xml","payload":{}}',
        )
        for body in invalid_bodies:
            with self.subTest(body=body):
                with self.assertRaises(MappingRequestError):
                    decode_mapping_request(body)

    def test_flattens_json_nested_fields_and_preserves_values_locally(self):
        values = flatten_json_payload({
            "ProductCode": "SKU-0001",
            "Pricing": {"UnitPrice": 4.99},
            "Tags": ["Fresh", "Produce"],
        })
        self.assertEqual(values["/ProductCode"], "SKU-0001")
        self.assertEqual(values["/Pricing/UnitPrice"], 4.99)
        self.assertEqual(values["/Tags/0"], "Fresh")


class ProductMappingTests(unittest.TestCase):
    def setUp(self):
        self.payload = {
            "ProductCode": "SKU-0001",
            "ProductName": "Organic Apples 1",
            "ProductCategory": "Fresh Produce",
            "UnitPrice": 4.99,
        }

    def test_maps_json_using_only_field_metadata_for_gemini(self):
        proposal_client = FakeProposalClient(proposal())
        result = ProductMappingService(proposal_client).map_product("json", self.payload)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["canonicalVersion"], "Product-v1")
        self.assertEqual(result["data"], {
            "sku": "SKU-0001",
            "name": "Organic Apples 1",
            "category": "Fresh Produce",
            "price": 4.99,
        })
        self.assertNotIn("SKU-0001", json.dumps(proposal_client.received_fields))
        self.assertEqual(
            proposal_client.received_fields,
            [
                {"path": "/ProductCode", "type": "string"},
                {"path": "/ProductName", "type": "string"},
                {"path": "/ProductCategory", "type": "string"},
                {"path": "/UnitPrice", "type": "number"},
            ],
        )

    def test_missing_each_required_target_returns_needs_review(self):
        for missing_target in ("sku", "name", "category", "price"):
            mappings = [item for item in expected_mappings() if item["targetField"] != missing_target]
            with self.subTest(target=missing_target):
                with self.assertRaises(MappingNeedsReviewError) as context:
                    ProductMappingService(FakeProposalClient(proposal(mappings=mappings))).map_product(
                        "json", self.payload
                    )
                self.assertEqual(context.exception.status_code, 422)
                self.assertEqual(context.exception.to_response()["status"], "needsReview")
                self.assertNotIn("data", context.exception.to_response())

    def test_unknown_source_path_is_rejected(self):
        mappings = expected_mappings()
        mappings[0] = {"targetField": "sku", "sourcePath": "/DoesNotExist"}
        with self.assertRaises(MappingNeedsReviewError):
            ProductMappingService(FakeProposalClient(proposal(mappings=mappings))).map_product(
                "json", self.payload
            )

    def test_target_outside_allowlist_is_rejected(self):
        mappings = expected_mappings()
        mappings[0] = {"targetField": "customerId", "sourcePath": "/ProductCode"}
        with self.assertRaises(MappingNeedsReviewError):
            ProductMappingService(FakeProposalClient(proposal(mappings=mappings))).map_product(
                "json", self.payload
            )

    def test_duplicate_target_or_reused_source_path_is_rejected(self):
        mappings = expected_mappings() + [
            {"targetField": "sku", "sourcePath": "/ProductName"}
        ]
        with self.assertRaises(MappingNeedsReviewError):
            ProductMappingService(FakeProposalClient(proposal(mappings=mappings))).map_product(
                "json", self.payload
            )

        mappings = expected_mappings()
        mappings[1] = {"targetField": "name", "sourcePath": "/ProductCode"}
        with self.assertRaises(MappingNeedsReviewError):
            ProductMappingService(FakeProposalClient(proposal(mappings=mappings))).map_product(
                "json", self.payload
            )

    def test_ambiguous_confidence_or_warning_requires_review(self):
        for confidence, warnings in (
            ("medium", []),
            ("high", ["Possible category/name ambiguity"]),
        ):
            with self.subTest(confidence=confidence, warnings=warnings):
                with self.assertRaises(MappingNeedsReviewError):
                    ProductMappingService(
                        FakeProposalClient(proposal(confidence=confidence, warnings=warnings))
                    ).map_product("json", self.payload)

    def test_invalid_prices_are_not_accepted(self):
        for invalid_price in (True, -1, "NaN", "not-a-price", float("inf")):
            source = dict(self.payload, UnitPrice=invalid_price)
            with self.subTest(price=invalid_price):
                with self.assertRaises(MappingNeedsReviewError):
                    ProductMappingService(FakeProposalClient(proposal())).map_product(
                        "json", source
                    )

    def test_missing_gemini_configuration_does_not_fall_back_to_another_provider(self):
        client = GeminiMappingClient("", "", 1000)
        with self.assertRaises(GeminiUnavailableError):
            ProductMappingService(client).map_product("json", self.payload)

    def test_timeout_and_provider_errors_are_mapped(self):
        with self.assertRaises(GeminiTimeoutError):
            ProductMappingService(
                FakeProposalClient(GeminiTimeoutError())
            ).map_product("json", self.payload)
        with self.assertRaises(GeminiUnavailableError):
            ProductMappingService(
                FakeProposalClient(GeminiUnavailableError("GEMINI_API_ERROR", "Provider error"))
            ).map_product("json", self.payload)


class GeminiClientTests(unittest.TestCase):
    class FakeResponse:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            del _args
            return False

        def read(self, _limit):
            del _limit
            return self.body

    def test_calls_google_gemini_structured_output_with_source_paths_only(self):
        response_body = {
            "candidates": [{
                "content": {
                    "parts": [{"text": json.dumps(proposal())}]
                }
            }]
        }
        client = GeminiMappingClient("test-key", "gemini-test-model", 1000)
        source_fields = [{"path": "/ProductCode", "type": "string"}]

        with patch(
            "ai_mapping.gemini_client.urlopen",
            return_value=self.FakeResponse(json.dumps(response_body).encode()),
        ) as open_url:
            result = client.propose(source_fields)

        request = open_url.call_args.args[0]
        request_body = json.loads(request.data.decode())
        prompt = request_body["contents"][0]["parts"][0]["text"]
        self.assertEqual(result.confidence, "high")
        self.assertTrue(request.full_url.startswith(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent"
        ))
        self.assertEqual(request.get_header("X-goog-api-key"), "test-key")
        self.assertIn("/ProductCode", prompt)
        self.assertNotIn("SKU-0001", prompt)
        self.assertEqual(
            request_body["generationConfig"]["responseFormat"]["text"]["mimeType"],
            "APPLICATION_JSON",
        )

    def test_missing_api_key_or_model_fails_before_network(self):
        for client in (
            GeminiMappingClient("", "gemini-test-model", 1000),
            GeminiMappingClient("test-key", "", 1000),
        ):
            with self.subTest(model=client.model):
                with patch("ai_mapping.gemini_client.urlopen") as open_url:
                    with self.assertRaises(GeminiUnavailableError):
                        client.propose([{"path": "/ProductCode", "type": "string"}])
                open_url.assert_not_called()

    def test_gemini_timeout_maps_to_504(self):
        client = GeminiMappingClient("test-key", "gemini-test-model", 1)
        with patch("ai_mapping.gemini_client.urlopen", side_effect=socket.timeout()):
            with self.assertRaises(GeminiTimeoutError):
                client.propose([{"path": "/ProductCode", "type": "string"}])

    def test_gemini_quota_and_auth_errors_map_to_503_without_body_leak(self):
        client = GeminiMappingClient("test-key", "gemini-test-model", 1000)
        for status, reason in ((403, "invalid API key"), (429, "quota exhausted")):
            provider_error = HTTPError(
                "https://example.invalid",
                status,
                reason,
                hdrs=None,
                fp=None,
            )
            with self.subTest(status=status):
                with patch("ai_mapping.gemini_client.urlopen", side_effect=provider_error):
                    with self.assertRaises(GeminiUnavailableError) as context:
                        client.propose([{"path": "/ProductCode", "type": "string"}])
                self.assertNotIn("test-key", str(context.exception))


class MappingApiTests(unittest.TestCase):
    def test_success_and_needs_review_response_statuses(self):
        service = FakeMappingService()
        app = create_app(service)
        status, response = call_asgi(
            app,
            "POST",
            "/api/v1/mapping/products",
            json.dumps({"format": "json", "payload": {"ProductCode": "SKU-0001"}}).encode(),
        )
        self.assertEqual(status, 200)
        self.assertEqual(response["canonicalVersion"], "Product-v1")
        self.assertEqual(service.calls[0][0], "json")

    def test_needs_review_response_does_not_include_canonical_data(self):
        review = {
            "status": "needsReview",
            "canonicalVersion": "Product-v1",
            "mapping": {"sku": "/ProductCode"},
            "confidence": "low",
            "unmappedFields": ["name", "category", "price"],
            "warnings": ["Required fields are not confidently mapped"],
        }
        service = FakeMappingService(
            error=MappingNeedsReviewError(
                mapping=review["mapping"],
                unmapped_fields=review["unmappedFields"],
                warnings=review["warnings"],
                confidence=review["confidence"],
            )
        )
        status, response = call_asgi(
            create_app(service),
            "POST",
            "/api/v1/mapping/products",
            json.dumps({"format": "json", "payload": {"ProductCode": "SKU-0001"}}).encode(),
        )

        self.assertEqual(status, 422)
        self.assertEqual(response, review)
        self.assertNotIn("data", response)

    def test_rejects_invalid_json_and_xml_envelopes_without_calling_model(self):
        service = FakeMappingService()
        app = create_app(service)
        invalid_json_status, _ = call_asgi(
            app,
            "POST",
            "/api/v1/mapping/products",
            b'{"format":"json","payload":',
        )
        invalid_envelope_status, _ = call_asgi(
            app,
            "POST",
            "/api/v1/mapping/products",
            json.dumps({"format": "xml", "payload": {"Product": "not XML text"}}).encode(),
        )
        self.assertEqual(invalid_json_status, 400)
        self.assertEqual(invalid_envelope_status, 400)
        self.assertEqual(service.calls, [])

    def test_rejects_oversized_body(self):
        status, response = call_asgi(
            create_app(FakeMappingService()),
            "POST",
            "/api/v1/mapping/products",
            b" " * (1_048_577),
        )
        self.assertEqual(status, 413)
        self.assertEqual(response["error"]["code"], "PAYLOAD_TOO_LARGE")

    def test_gemini_unavailable_and_timeout_keep_their_http_status(self):
        cases = (
            (GeminiUnavailableError("GEMINI_API_ERROR", "Provider unavailable"), 503),
            (GeminiTimeoutError(), 504),
        )
        for error, expected_status in cases:
            with self.subTest(status=expected_status):
                status, response = call_asgi(
                    create_app(FakeMappingService(error=error)),
                    "POST",
                    "/api/v1/mapping/products",
                    json.dumps({"format": "json", "payload": {"ProductCode": "SKU-0001"}}).encode(),
                )
                self.assertEqual(status, expected_status)
                self.assertEqual(response["status"], "error")


@unittest.skipUnless(importlib.util.find_spec("defusedxml"), "defusedxml is not installed")
class SecureXmlTests(unittest.TestCase):
    def test_parses_xml_to_exact_source_paths_and_maps_product(self):
        xml = (
            "<Product><ProductCode>SKU-0001</ProductCode>"
            "<ProductName>Organic Apples 1</ProductName>"
            "<ProductCategory>Fresh Produce</ProductCategory>"
            "<UnitPrice>4.99</UnitPrice></Product>"
        )
        values = flatten_xml_payload(xml)
        xml_proposal = {
            "mappings": [
                {"targetField": "sku", "sourcePath": "/Product/ProductCode"},
                {"targetField": "name", "sourcePath": "/Product/ProductName"},
                {"targetField": "category", "sourcePath": "/Product/ProductCategory"},
                {"targetField": "price", "sourcePath": "/Product/UnitPrice"},
            ],
            "confidence": "high",
            "warnings": [],
        }
        result = ProductMappingService(FakeProposalClient(xml_proposal)).map_product("xml", xml)
        self.assertEqual(values["/Product/UnitPrice"], "4.99")
        self.assertEqual(result["data"]["sku"], "SKU-0001")
        self.assertEqual(result["data"]["price"], 4.99)

    def test_malformed_xml_and_dtd_are_rejected(self):
        for xml in (
            "<Product><broken></Product>",
            '<!DOCTYPE Product [<!ENTITY x "value">]><Product>&x;</Product>',
        ):
            with self.subTest(xml=xml[:20]):
                with self.assertRaises(MappingRequestError):
                    flatten_xml_payload(xml)


if __name__ == "__main__":
    unittest.main()
