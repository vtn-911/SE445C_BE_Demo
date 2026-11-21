from collections import Counter

from .errors import MappingRequestError, MappingServiceUnavailableError


MAX_SOURCE_FIELDS = 512
MAX_SOURCE_PATH_LENGTH = 512


def _escape_json_pointer_segment(value):
    return str(value).replace("~", "~0").replace("/", "~1")


def _add_source_value(values, path, value):
    if len(path) > MAX_SOURCE_PATH_LENGTH:
        raise MappingRequestError("SOURCE_PATH_TOO_LONG", "A source field path is too long")
    values[path] = value
    if len(values) > MAX_SOURCE_FIELDS:
        raise MappingRequestError("TOO_MANY_SOURCE_FIELDS", "The source contains too many fields")


def _flatten_json(value, path, values):
    if isinstance(value, dict):
        for key, child in value.items():
            _flatten_json(child, f"{path}/{_escape_json_pointer_segment(key)}", values)
        return

    if isinstance(value, list):
        for index, child in enumerate(value):
            _flatten_json(child, f"{path}/{index}", values)
        return

    _add_source_value(values, path, value)


def _xml_tag_path(parent_path, tag, sibling_index=None):
    segment = str(tag)
    if sibling_index is not None:
        segment = f"{segment}[{sibling_index}]"
    return f"{parent_path}/{segment}" if parent_path else f"/{segment}"


def _flatten_xml(element, path, values):
    for name, value in element.attrib.items():
        _add_source_value(values, f"{path}/@{name}", value)

    children = list(element)
    text = (element.text or "").strip()
    if text:
        text_path = f"{path}/#text" if children else path
        _add_source_value(values, text_path, text)
    elif not children and not element.attrib:
        _add_source_value(values, path, "")

    tag_counts = Counter(child.tag for child in children)
    seen_tags = Counter()
    for child in children:
        seen_tags[child.tag] += 1
        sibling_index = seen_tags[child.tag] if tag_counts[child.tag] > 1 else None
        _flatten_xml(child, _xml_tag_path(path, child.tag, sibling_index), values)


def flatten_json_payload(payload):
    if not isinstance(payload, dict):
        raise MappingRequestError("INVALID_JSON_PAYLOAD", "JSON payload must be a product object")

    values = {}
    _flatten_json(payload, "", values)
    if not values:
        raise MappingRequestError("EMPTY_SOURCE", "The source payload contains no fields")
    return values


def flatten_xml_payload(payload):
    if not isinstance(payload, str) or not payload.strip():
        raise MappingRequestError("INVALID_XML_PAYLOAD", "XML payload must be a non-empty string")

    try:
        from defusedxml import ElementTree as SafeElementTree
        from defusedxml.common import DefusedXmlException
    except ImportError as error:
        raise MappingServiceUnavailableError() from error

    try:
        root = SafeElementTree.fromstring(
            payload,
            forbid_dtd=True,
            forbid_entities=True,
            forbid_external=True,
        )
    except (SafeElementTree.ParseError, DefusedXmlException, ValueError):
        raise MappingRequestError(
            "INVALID_XML",
            "XML payload is malformed or contains prohibited declarations",
        ) from None

    values = {}
    _flatten_xml(root, _xml_tag_path("", root.tag), values)
    if not values:
        raise MappingRequestError("EMPTY_SOURCE", "The source payload contains no fields")
    return values


def flatten_source(format_name, payload):
    if format_name == "json":
        return flatten_json_payload(payload)
    if format_name == "xml":
        return flatten_xml_payload(payload)
    raise MappingRequestError("UNSUPPORTED_FORMAT", "format must be either json or xml")


def source_type(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "unsupported"


def describe_source_fields(values):
    return [{"path": path, "type": source_type(value)} for path, value in values.items()]
