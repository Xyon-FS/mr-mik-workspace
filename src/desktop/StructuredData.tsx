import { useMemo, useState } from 'react'
import type { StructuredValue } from './parseStructuredData'

function JsonCopy({ value, label, children, title }: { value: string; label: string; children: string; title?: string }) {
  const [notice, setNotice] = useState('')
  return <button type="button" title={title} aria-label={label} onClick={() => { void (async () => {
    try { await navigator.clipboard.writeText(value); setNotice('Copied') }
    catch { setNotice('Copy unavailable') }
  })() }}>{notice ? <span role="status">{notice}</span> : children}</button>
}

function JsonNode({ name, value, depth = 0, path = '$' }: { name: string; value: unknown; depth?: number; path?: string }) {
  const [open, setOpen] = useState(depth === 0), [limit, setLimit] = useState(50)
  if (value === null || typeof value !== 'object') return <div className="structured-json-leaf"><span className="structured-json-key">{name}</span><span className={`structured-json-value ${typeof value}`}>{JSON.stringify(value)}</span><JsonCopy title={path} label={`Copy JSON path ${path}`} value={path}>Path</JsonCopy><JsonCopy label={`Copy JSON value ${path}`} value={JSON.stringify(value)}>Copy</JsonCopy></div>
  const entries = Object.entries(value), label = Array.isArray(value) ? `${entries.length} items` : `${entries.length} properties`
  if (depth >= 12) return <p>{name} · {label} · Open Code to inspect deeper levels.</p>
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="structured-json-node"><summary><span>{name}</span><small>{Array.isArray(value) ? '[ ]' : '{ }'} · {label}</small></summary>{open && <div>{entries.slice(0, limit).map(([key, entry]) => <JsonNode key={key} name={key} value={entry} depth={depth + 1} path={Array.isArray(value) ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`} />)}{entries.length > limit && <button type="button" onClick={() => setLimit(value => value + 50)}>Show next {Math.min(50, entries.length - limit)}</button>}</div>}</details>
}

function Chart({ rows, x, y, line }: { rows: string[][]; x: number; y: number; line: boolean }) {
  const values = rows.slice(0, 200).map(row => ({ label: row[x] || '', value: row[y]?.trim() ? Number(row[y]) : NaN }))
  if (!values.length || values.some(point => !Number.isFinite(point.value))) return <p role="status">Choose a numeric value column with no empty cells to draw this chart.</p>
  const low = Math.min(0, ...values.map(point => point.value)), high = Math.max(0, ...values.map(point => point.value)), span = high - low || 1
  const at = (value: number) => 160 - (value - low) / span * 140, width = 320 / values.length
  const single = values.length === 1 ? values[0] : null
  return <figure className="structured-chart"><svg viewBox="0 0 380 195" role="img" aria-label={line ? 'Selected data line chart' : 'Selected data bar chart'}><title>Chart of selected columns · first {values.length} filtered rows</title><path d={`M40 20V160H365M40 ${at(0)}H365`} stroke="currentColor" fill="none" opacity=".4" />{line && single ? <circle cx="200" cy={at(single.value)} r="4" fill="var(--pink)"><title>{single.label}: {single.value}</title></circle> : line ? <polyline fill="none" stroke="var(--pink)" strokeWidth="2" points={values.map((point, index) => `${40 + width * (index + .5)},${at(point.value)}`).join(' ')} /> : values.map((point, index) => <rect key={index} x={40 + width * index + 1} y={Math.min(at(0), at(point.value))} width={Math.max(.5, width - 2)} height={Math.abs(at(point.value) - at(0))} fill="var(--pink)"><title>{point.label}: {point.value}</title></rect>)}<text x="3" y="25">{high}</text><text x="3" y="160">{low}</text>{single ? <text x="200" y="185" textAnchor="middle">{single.label.slice(0, 18)}</text> : <><text x="40" y="185">{values[0].label.slice(0, 18)}</text><text x="360" y="185" textAnchor="end">{values[values.length - 1].label.slice(0, 18)}</text></>}</svg><figcaption>{rows.length > 200 ? 'First 200 filtered rows.' : `${rows.length} filtered rows.`} View only; the original data is unchanged.</figcaption></figure>
}
export default function StructuredData({ data }: { data: StructuredValue }) {
  const [limit, setLimit] = useState(50), [query, setQuery] = useState(''), [sort, setSort] = useState(''), [descending, setDescending] = useState(false), [pin, setPin] = useState(false), [chart, setChart] = useState('table'), [x, setX] = useState(0), [y, setY] = useState(1)
  const rows = useMemo(() => {
    if (data.kind !== 'table') return []
    const rows = data.cells.slice(1).filter(row => row.some(value => value.toLowerCase().includes(query.toLowerCase())))
    if (sort !== '') rows.sort((a, b) => { const left = a[Number(sort)] || '', right = b[Number(sort)] || '', numeric = left.trim() && right.trim() && Number.isFinite(Number(left)) && Number.isFinite(Number(right)); return (descending ? -1 : 1) * (numeric ? Number(left) - Number(right) : left.localeCompare(right, undefined, { numeric: true })) })
    return rows
  }, [data, query, sort, descending])
  const found = useMemo(() => {
    if (data.kind !== 'json' || !query.trim()) return []
    const result: { path: string; value: unknown }[] = [], queue = [{ path: '$', value: data.value }]; let visited = 0, cursor = 0
    while (cursor < queue.length && visited++ < 5000 && result.length < 100) {
      const entry = queue[cursor++]
      if (entry.value && typeof entry.value === 'object') {
        for (const [key, value] of Object.entries(entry.value)) {
          if (queue.length >= 5000) break
          queue.push({ path: Array.isArray(entry.value) ? `${entry.path}[${key}]` : `${entry.path}[${JSON.stringify(key)}]`, value })
        }
      } else if (`${entry.path} ${JSON.stringify(entry.value)}`.toLowerCase().includes(query.toLowerCase())) result.push(entry)
    }
    return result
  }, [data, query])
  if (data.kind === 'json') return <div className="structured-json"><details className="json-search-tools"><summary>Search JSON</summary><input aria-label="Search JSON" placeholder="Search keys and values…" value={query} onChange={event => setQuery(event.target.value)} /></details>{query ? <><small>Up to 100 matches in the first 5,000 inspected nodes.</small>{found.map(entry => <div className="structured-json-match" key={entry.path}><code>{entry.path}</code><span>{JSON.stringify(entry.value)}</span><JsonCopy label="Copy path" value={entry.path}>Copy path</JsonCopy><JsonCopy label="Copy value" value={JSON.stringify(entry.value)}>Copy value</JsonCopy></div>)}{!found.length && <p>No matching inspected values.</p>}</> : <JsonNode name="Root" value={data.value} />}</div>
  return <><details className="structured-table-tools"><summary>Explore data<span>{query ? ' · filtered' : sort ? ' · sorted' : chart !== 'table' ? ' · chart' : ''}</span></summary><div className="structured-table-controls"><input aria-label="Filter table rows" placeholder="Filter rows…" value={query} onChange={event => { setQuery(event.target.value); setLimit(50) }} /><label>Sort<select aria-label="Sort table column" value={sort} onChange={event => setSort(event.target.value)}><option value="">Source order</option>{data.cells[0].map((label, index) => <option key={index} value={index}>{label}</option>)}</select></label><button type="button" aria-pressed={descending} onClick={() => setDescending(value => !value)}>Descending</button><label><input type="checkbox" checked={pin} onChange={event => setPin(event.target.checked)} />Pin first column</label><div role="group" aria-label="Table visualization">{['table', 'bar', 'line'].map(value => <button type="button" key={value} aria-pressed={chart === value} onClick={() => setChart(value)}>{value === 'table' ? 'Table' : value === 'bar' ? 'Bar chart' : 'Line chart'}</button>)}</div>{chart !== 'table' && <>{[['Category column', x, setX], ['Value column', y, setY]].map(([label, value, change]) => <label key={String(label)}>{String(label)}<select aria-label={String(label)} value={Number(value)} onChange={event => (change as (value: number) => void)(Number(event.target.value))}>{data.cells[0].map((header, index) => <option key={index} value={index}>{header}</option>)}</select></label>)}</>}</div></details>{chart !== 'table' ? <Chart rows={rows} x={x} y={y} line={chart === 'line'} /> : <table className={pin ? 'structured-pinned-column' : undefined}><thead><tr>{data.cells[0].map((value, index) => <th key={index} scope="col">{value}</th>)}</tr></thead><tbody>{rows.slice(0, limit).map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody></table>}{chart === 'table' && rows.length > limit && <div className="structured-table-more"><span>Showing {limit} of {rows.length} filtered rows</span><button type="button" onClick={() => setLimit(value => value + 50)}>Show next {Math.min(50, rows.length - limit)} rows</button></div>}</>
}
