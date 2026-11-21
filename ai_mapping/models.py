import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


TargetField = Literal["sku", "name", "category", "price"]


class MappingEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: Literal["json", "xml"]
    payload: Any

    @model_validator(mode="after")
    def validate_format_payload(self):
        if self.format == "json" and not isinstance(self.payload, dict):
            raise ValueError("JSON format requires an object payload")
        if self.format == "xml" and (
            not isinstance(self.payload, str) or not self.payload.strip()
        ):
            raise ValueError("XML format requires a non-empty string payload")
        return self


class FieldMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")

    targetField: TargetField
    sourcePath: str = Field(min_length=1, max_length=512)


class MappingProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mappings: list[FieldMapping]
    confidence: Literal["high", "medium", "low"]
    warnings: list[str] = Field(default_factory=list, max_length=20)


class CanonicalProduct(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    sku: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]{1,100}$")
    name: str = Field(min_length=1)
    category: str = Field(min_length=1)
    price: float = Field(ge=0, allow_inf_nan=False)

    @field_validator("price", mode="before")
    @classmethod
    def reject_boolean_price(cls, value):
        if isinstance(value, bool):
            raise ValueError("price must be a number, not a boolean")
        return value

    @field_validator("price")
    @classmethod
    def require_finite_price(cls, value):
        if not math.isfinite(value):
            raise ValueError("price must be finite")
        return value
