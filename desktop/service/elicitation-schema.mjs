// Shared browser/service contract for the native MCP flat form schema.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const known = (value, keys) => Object.keys(value).every(key => keys.includes(key) || value[key] == null);
const metadata = ['type', 'title', 'description', 'default'];
const unsupported = () => ({ fields: [], error: 'This tool requests an unsupported form. Decline or cancel it; no response will be sent automatically.' });

export function elicitationFields(schema) {
  if (!object(schema) || schema.type !== 'object' || !object(schema.properties) || !known(schema, ['type', 'properties', 'required', '$schema', 'title', 'description', 'additionalProperties']) || schema.additionalProperties != null && schema.additionalProperties !== false) return unsupported();
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key))) return unsupported();
  const entries = Object.entries(schema.properties);
  if (entries.length > 40) return unsupported();
  const fields = [];
  for (const [name, rule] of entries) {
    if (!object(rule) || !['string', 'number', 'integer', 'boolean', 'array'].includes(rule.type)) return unsupported();
    const numeric = ['number', 'integer'].includes(rule.type);
    let options = null;
    const choices = rule.type === 'array' ? rule.items : rule;
    if (object(choices) && Array.isArray(choices.enum)) {
      if (!choices.enum.length || choices.enum.length > 100 || new Set(choices.enum).size !== choices.enum.length || choices.enum.some(value => typeof value !== 'string') || choices.enumNames != null && (!Array.isArray(choices.enumNames) || choices.enumNames.length !== choices.enum.length)) return unsupported();
      options = choices.enum.map((value, index) => ({ value, label: String(choices.enumNames?.[index] ?? value) }));
    } else if (object(choices) && Array.isArray(choices.oneOf)) {
      if (!choices.oneOf.length || choices.oneOf.length > 100 || choices.oneOf.some(value => !object(value) || typeof value.const !== 'string' || typeof value.title !== 'string' || !known(value, ['const', 'title']))) return unsupported();
      options = choices.oneOf.map(value => ({ value: value.const, label: value.title }));
    }
    const allowed = [...metadata, ...(numeric ? ['minimum', 'maximum'] : rule.type === 'string' ? ['minLength', 'maxLength', 'format', 'enum', 'enumNames', 'oneOf'] : rule.type === 'array' ? ['items', 'minItems', 'maxItems'] : [])];
    if (!known(rule, allowed) || rule.type === 'array' && (!options || !known(rule.items, ['type', 'enum', 'enumNames', 'oneOf']) || rule.items.type != null && rule.items.type !== 'string') || numeric && options) return unsupported();
    if (rule.format != null && !['email', 'uri', 'date', 'date-time'].includes(rule.format)) return unsupported();
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (rule[key] != null && (!Number.isFinite(rule[key]) || !['minimum', 'maximum'].includes(key) && (!Number.isInteger(rule[key]) || rule[key] < 0))) return unsupported();
    }
    fields.push({ name, title: String(rule.title || name), description: String(rule.description || ''), type: rule.type, required: required.includes(name), options, rule });
  }
  return { fields, error: '' };
}

export function validateElicitation(schema, content) {
  const form = elicitationFields(schema), errors = Object.create(null);
  if (form.error) return { valid: false, errors, error: form.error };
  if (!object(content) || Object.keys(content).some(key => !Object.hasOwn(schema.properties, key))) return { valid: false, errors, error: 'Respond only with the requested form fields.' };
  for (const field of form.fields) {
    const value = content[field.name], rule = field.rule;
    let error = '';
    if (!Object.hasOwn(content, field.name)) { if (field.required) error = 'This field is required.'; }
    else if (field.type === 'array') {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !field.options.some(option => option.value === item)) || new Set(value).size !== value.length) error = 'Choose valid options.';
      else if (rule.minItems != null && value.length < rule.minItems || rule.maxItems != null && value.length > rule.maxItems) error = 'Choose the requested number of options.';
    } else if (typeof value !== (['number', 'integer'].includes(field.type) ? 'number' : field.type)) error = 'Enter a valid value.';
    else if (typeof value === 'number' && (!Number.isFinite(value) || field.type === 'integer' && !Number.isInteger(value) || rule.minimum != null && value < rule.minimum || rule.maximum != null && value > rule.maximum)) error = 'Enter a number within the requested range.';
    else if (typeof value === 'string') {
      if (field.required && !value.trim()) error = 'This field is required.';
      else if (rule.minLength != null && [...value].length < rule.minLength || rule.maxLength != null && [...value].length > rule.maxLength) error = 'Check the requested text length.';
      else if (field.options && !field.options.some(option => option.value === value)) error = 'Choose a valid option.';
      else if (rule.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) error = 'Enter a valid email address.';
      else if (rule.format === 'uri') { try { new URL(value); } catch { error = 'Enter an absolute URL.'; } }
      else if (rule.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) error = 'Enter a valid date.';
      else if (rule.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))) error = 'Enter a date and time including its timezone.';
    }
    if (error) errors[field.name] = error;
  }
  return { valid: !Object.keys(errors).length, errors, error: '' };
}
