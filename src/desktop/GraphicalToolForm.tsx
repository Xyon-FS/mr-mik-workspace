import { useId, useState } from 'react'
import DarkSelect from './DarkSelect'
import { elicitationFields, validateElicitation } from '../../desktop/service/elicitation-schema.mjs'

export default function GraphicalToolForm({ schema, disabled, answer }: { schema: unknown; disabled: boolean; answer: (content: object) => Promise<void> }) {
  const form = elicitationFields(schema)
  const prefix = useId()
  const selected = (value: string | string[] | undefined): string[] => Array.isArray(value) ? value : []
  const [values, setValues] = useState<Record<string, string | string[]>>(() => Object.fromEntries(form.fields.filter(field => field.rule.default != null).map(field => [field.name, Array.isArray(field.rule.default) ? field.rule.default as string[] : String(field.rule.default)])))
  const content = Object.fromEntries(form.fields.filter(field => Object.prototype.hasOwnProperty.call(values, field.name) && (Array.isArray(values[field.name]) || values[field.name] !== '')).map(field => {
    const value = values[field.name]
    return [field.name, field.type === 'boolean' ? value === 'true' : ['number', 'integer'].includes(field.type) ? Number(value) : value]
  }))
  const checked = validateElicitation(schema, content)
  const [submitted, setSubmitted] = useState(false)
  if (form.error) return <p role="status" className="graphical-form-error">{form.error}</p>
  return <form className="graphical-tool-form" onSubmit={event => { event.preventDefault(); setSubmitted(true); if (checked.valid) void answer(content) }}>
    <fieldset disabled={disabled}>{form.fields.map(field => <div key={field.name} className="graphical-tool-field">
      <label htmlFor={`${prefix}-${field.name}`}>{field.title}{field.required ? ' *' : ' (optional)'}</label>
      {field.description && <small>{field.description}</small>}
      {field.type === 'array' ? <div role="group" aria-label={field.title}>{field.options?.map(option => <label key={option.value} className="graphical-tool-choice"><input type="checkbox" checked={selected(values[field.name]).includes(option.value)} onChange={event => setValues(previous => ({ ...previous, [field.name]: event.target.checked ? [...selected(previous[field.name]), option.value] : selected(previous[field.name]).filter(value => value !== option.value) }))} />{option.label}</label>)}</div> : field.options || field.type === 'boolean' ? <DarkSelect label={field.title} value={String(values[field.name] ?? '')} disabled={disabled} options={[{ value: '', label: 'Choose…' }, ...(field.options || [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }])]} onChange={value => setValues(previous => ({ ...previous, [field.name]: value }))} /> : <input id={`${prefix}-${field.name}`} aria-label={field.title} autoComplete="off" type={['number', 'integer'].includes(field.type) ? 'number' : field.rule.format === 'date' ? 'date' : field.rule.format === 'email' ? 'email' : 'text'} step={field.type === 'integer' ? 1 : 'any'} value={String(values[field.name] ?? '')} onChange={event => setValues(previous => ({ ...previous, [field.name]: event.target.value }))} />}
      {submitted && checked.errors[field.name] && <small role="alert">{checked.errors[field.name]}</small>}
    </div>)}</fieldset>
    <button type="submit" disabled={disabled}>Send response</button>
  </form>
}
