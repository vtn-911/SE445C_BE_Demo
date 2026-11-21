import math
from decimal import Decimal, InvalidOperation

from pydantic import ValidationError

from .errors import GeminiUnavailableError, MappingNeedsReviewError
from .models import CanonicalProduct, MappingProposal
from .source_parser import describe_source_fields, flatten_source


REQUIRED_FIELDS = ("sku", "name", "category", "price")


class ProductMappingService:
    def __init__(self, proposal_client):
        self.proposal_client = proposal_client

    def map_product(self, format_name, payload):
        source_values = flatten_source(format_name, payload)
        source_fields = describe_source_fields(source_values)

        try:
            proposal = self.proposal_client.propose(source_fields)
        except GeminiUnavailableError:
            raise
        except (ValueError, ValidationError):
            raise MappingNeedsReviewError(
                mapping={},
                unmapped_fields=list(REQUIRED_FIELDS),
                warnings=["Gemini returned a proposal that did not match the mapping contract"],
            ) from None

        if not isinstance(proposal, MappingProposal):
            try:
                proposal = MappingProposal.model_validate(proposal)
            except ValidationError:
                raise MappingNeedsReviewError(
                    mapping={},
                    unmapped_fields=list(REQUIRED_FIELDS),
                    warnings=["Gemini returned a proposal that did not match the mapping contract"],
                ) from None

        accepted_mapping = {}
        used_source_paths = set()
        warnings = list(proposal.warnings)
        invalid_proposal = False

        for entry in proposal.mappings:
            target = entry.targetField
            source_path = entry.sourcePath
            if target in accepted_mapping:
                warnings.append(f"Multiple source paths were proposed for {target}")
                invalid_proposal = True
                continue
            if source_path not in source_values:
                warnings.append(f"The proposed source path for {target} does not exist")
                invalid_proposal = True
                continue
            if source_path in used_source_paths:
                warnings.append("One source path was proposed for multiple target fields")
                invalid_proposal = True
                continue

            accepted_mapping[target] = source_path
            used_source_paths.add(source_path)

        unmapped_fields = [field for field in REQUIRED_FIELDS if field not in accepted_mapping]
        if invalid_proposal or unmapped_fields or proposal.confidence != "high" or warnings:
            raise MappingNeedsReviewError(
                mapping=accepted_mapping,
                unmapped_fields=unmapped_fields,
                warnings=warnings or ["Mapping confidence is not high"],
                confidence=proposal.confidence,
            )

        values = {
            target: source_values[source_path]
            for target, source_path in accepted_mapping.items()
        }
        try:
            values["price"] = self._normalize_price(values["price"])
            product = CanonicalProduct.model_validate(values)
        except (InvalidOperation, TypeError, ValueError, ValidationError) as error:
            fields = []
            if isinstance(error, ValidationError):
                fields = sorted(
                    {
                        str(item["loc"][0])
                        for item in error.errors(include_input=False)
                        if item.get("loc")
                    }
                )
            if not fields:
                fields = ["price"]
            raise MappingNeedsReviewError(
                mapping=accepted_mapping,
                unmapped_fields=fields,
                warnings=["Mapped values do not satisfy Canonical Product v1"],
                confidence=proposal.confidence,
            ) from None

        return {
            "status": "success",
            "canonicalVersion": "Product-v1",
            "data": product.model_dump(mode="json"),
            "mapping": accepted_mapping,
            "confidence": proposal.confidence,
            "warnings": [],
        }

    @staticmethod
    def _normalize_price(value):
        if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
            raise TypeError("price must be numeric")
        try:
            amount = Decimal(str(value).strip())
        except (InvalidOperation, ValueError):
            raise ValueError("price must be numeric") from None
        if not amount.is_finite() or amount < 0:
            raise ValueError("price must be finite and non-negative")
        normalized = float(amount)
        if not math.isfinite(normalized):
            raise ValueError("price is outside the supported numeric range")
        return normalized
