import { useMemo, useState } from "react";
import { Chart, Legend, Sparkline, useHiddenSeries, type ChartSeries } from "../charts";
import { getBehaviorDashboardStats } from "../api";
import { formatInteger } from "../data/formatters";
import { useQuery } from "../data/query";
import type {
	BehaviorDashboardStats,
	BehaviorModelStats,
	BehaviorStatsOverall,
	BehaviorTimeSeriesPoint,
	TimeRange,
} from "../types";
import {
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	PageHeader,
	QueryView,
	Segmented,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";

export interface BehaviorRouteProps {
	active: boolean;
	range: TimeRange;
}

const METRICS = [
	{ value: "yelling", label: "CAPS", title: "Yelling (CAPS)" },
	{ value: "profanity", label: "Profanity", title: "Profanity" },
	{ value: "anguish", label: "Anguish", title: "Anguish (!!!, nooo, ugh, dude, :( )" },
	{ value: "negation", label: "Negation", title: "Negation (no/nope/wrong)" },
	{ value: "repetition", label: "Repetition", title: "Repetition (i meant, still doesnt)" },
	{ value: "blame", label: "Blame", title: "Blame (you didnt, why did you, stop X-ing)" },
	{ value: "frustration", label: "Friction", title: "Negation + repetition + blame" },
	{ value: "total", label: "All", title: "All behavior signals combined" },
] as const;

type Metric = (typeof METRICS)[number]["value"];
type ChartMode = "all" | "model";

const CHART_MODES = [
	{ value: "all" as const, label: "All models" },
	{ value: "model" as const, label: "By model" },
];

const MODEL_COLORS = ["var(--chart-primary)", "var(--chart-secondary)", "#9d7bff", "#e58b42", "#58c7b7"];
const SIGNAL_COLORS = {
	yelling: "#ed4abf",
	profanity: "#ff6b7d",
	anguish: "#9b4dff",
	frustration: "#5ad8e6",
} as const;
const NO_BEHAVIOR = <EmptyState title="No user behavior recorded in this range" />;

export function BehaviorRoute({ active, range }: BehaviorRouteProps) {
	const query = useQuery(["behavior", range], () => getBehaviorDashboardStats(range), { enabled: active });
	const [metric, setMetric] = useState<Metric>("total");
	const [mode, setMode] = useState<ChartMode>("all");
	const [hidden, toggleHidden] = useHiddenSeries();
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const view = useMemo(() => buildBehaviorView(query.data), [query.data]);
	const columns = useMemo(() => buildModelColumns(view.byModel), [view.byModel]);
	const chart = useMemo(
		() => buildBehaviorChart(query.data?.behaviorSeries ?? [], metric, mode),
		[query.data, metric, mode],
	);

	return (
		<div className="page">
			<PageHeader
				title="Behavior"
				description="Regex behavior signals recorded from user messages. These raw signals remain separate from judged frustration."
			/>

			<QueryView query={query} skeleton={<ChartSkeleton height={108} />}>
				{stats => <BehaviorSummary overall={stats.overall} byModel={stats.byModel} />}
			</QueryView>

			<Card
				index={1}
				title="User behavior signals"
				description={`${METRICS.find(option => option.value === metric)?.title ?? "Signals"} as a share of user messages per day`}
				actions={
					<div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
						<Segmented
							size="sm"
							options={METRICS.map(({ value, label, title }) => ({ value, label, title }))}
							value={metric}
							onChange={setMetric}
							aria-label="Behavior signal"
						/>
						<Segmented
							size="sm"
							options={CHART_MODES}
							value={mode}
							onChange={setMode}
							aria-label="Chart grouping"
						/>
					</div>
				}
				stale={query.stale}
			>
				<QueryView
					query={query}
					skeleton={<ChartSkeleton height={260} />}
					isEmpty={stats => stats.behaviorSeries.length === 0}
				>
					{stats => {
						const hasSeries = stats.behaviorSeries.length > 0;
						return !hasSeries || chart.days.length === 0 ? (
							<EmptyState title="No daily behavior signal data in this range" />
						) : (
							<div className="stack" style={{ gap: 12 }}>
								<Chart
									slots={chart.days.length}
									tickLabel={i => formatDay(chart.days[i])}
									tooltipTitle={i => formatDay(chart.days[i], true)}
									series={chart.series}
									kind={mode === "model" ? "line" : "bars"}
									stacked={false}
									height={260}
									hidden={hidden}
									format={value =>
										value === 0 ? "0%" : value < 1 ? `${value.toFixed(1)}%` : `${value.toFixed(0)}%`
									}
									formatTooltip={value => `${value.toFixed(2)}%`}
								/>
								<Legend
									items={chart.series.map(series => ({
										key: series.key,
										label: series.label,
										color: series.color,
									}))}
									hidden={hidden}
									onToggle={toggleHidden}
								/>
							</div>
						);
					}}
				</QueryView>
			</Card>

			<Card
				index={2}
				title="Behavior signals by model"
				description="Totals and rates per user message; select a row to expand its daily trend"
				flush
				stale={query.stale}
			>
				<QueryView
					query={query}
					skeleton={<TableSkeleton />}
					isEmpty={stats => stats.byModel.length === 0}
					empty={NO_BEHAVIOR}
				>
					{stats => (
						<Table
							columns={columns}
							rows={stats.byModel}
							rowKey={modelKey}
							selectedKey={expandedKey}
							onRowClick={row => setExpandedKey(current => (current === modelKey(row) ? null : modelKey(row)))}
							initialSort={{ key: "messages", dir: "desc" }}
							limit={20}
							expanded={row =>
								expandedKey === modelKey(row) ? (
									<BehaviorModelDetails model={row} series={view.byModel.get(modelKey(row)) ?? []} />
								) : null
							}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}

function BehaviorSummary({ overall, byModel }: { overall: BehaviorStatsOverall; byModel: BehaviorModelStats[] }) {
	const totalFriction = overall.totalNegation + overall.totalRepetition + overall.totalBlame;
	const highestFriction = byModel.reduce<BehaviorModelStats | null>((best, model) => {
		if (!best) return model;
		const rate = frictionTotal(model) / Math.max(1, model.totalMessages);
		const bestRate = frictionTotal(best) / Math.max(1, best.totalMessages);
		return rate > bestRate ? model : best;
	}, null);
	const highestTotal = highestFriction ? frictionTotal(highestFriction) : 0;
	const averageChars = overall.totalMessages > 0 ? Math.round(overall.totalChars / overall.totalMessages) : 0;
	return (
		<div className="stack" style={{ gap: 12 }}>
			<StatGrid min={160}>
				<Stat label="User messages" value={formatInteger(overall.totalMessages)} hint="in range" />
				<Stat
					label="Yelling (CAPS)"
					value={formatInteger(overall.totalYelling)}
					hint={perMessage(overall.totalYelling, overall.totalMessages)}
				/>
				<Stat
					label="Profanity hits"
					value={formatInteger(overall.totalProfanity)}
					hint={perMessage(overall.totalProfanity, overall.totalMessages)}
				/>
				<Stat
					label="Anguish signals"
					value={formatInteger(overall.totalAnguish)}
					hint={perMessage(overall.totalAnguish, overall.totalMessages)}
				/>
				<Stat
					label="Friction signals"
					value={formatInteger(totalFriction)}
					hint={perMessage(totalFriction, overall.totalMessages)}
				/>
				<Stat
					label="Highest-friction model"
					value={highestFriction?.model ?? "—"}
					hint={
						highestFriction
							? `${formatInteger(highestTotal)} hits · ${formatRate(highestTotal, highestFriction.totalMessages)}`
							: undefined
					}
					title={highestFriction ? `${highestFriction.model} (${highestFriction.provider})` : undefined}
				/>
			</StatGrid>
			<StatGrid min={140}>
				<Stat size="sm" label="Negation" value={formatInteger(overall.totalNegation)} />
				<Stat size="sm" label="Repetition" value={formatInteger(overall.totalRepetition)} />
				<Stat size="sm" label="Blame" value={formatInteger(overall.totalBlame)} />
				<Stat size="sm" label="Average chars / message" value={formatInteger(averageChars)} />
			</StatGrid>
		</div>
	);
}

interface DailyTotals {
	messages: number;
	hits: number;
}

interface BehaviorView {
	byModel: Map<string, BehaviorTimeSeriesPoint[]>;
}

function buildBehaviorView(stats: BehaviorDashboardStats | null): BehaviorView {
	const byModel = new Map<string, BehaviorTimeSeriesPoint[]>();
	for (const point of stats?.behaviorSeries ?? []) {
		const key = modelKey(point);
		const points = byModel.get(key);
		if (points) points.push(point);
		else byModel.set(key, [point]);
	}
	for (const points of byModel.values()) points.sort((a, b) => a.timestamp - b.timestamp);
	return { byModel };
}

function buildBehaviorChart(
	points: BehaviorTimeSeriesPoint[],
	metric: Metric,
	mode: ChartMode,
): {
	days: number[];
	series: ChartSeries[];
} {
	const byDay = new Map<number, DailyTotals>();
	const byModelDay = new Map<string, Map<number, DailyTotals>>();
	const models = new Map<string, { model: string; provider: string; messages: number }>();

	for (const point of points) {
		const day = byDay.get(point.timestamp) ?? { messages: 0, hits: 0 };
		day.messages += point.messages;
		day.hits += pointHits(point, metric);
		byDay.set(point.timestamp, day);

		const key = modelKey(point);
		const model = models.get(key) ?? { model: point.model, provider: point.provider, messages: 0 };
		model.messages += point.messages;
		models.set(key, model);
		let days = byModelDay.get(key);
		if (!days) {
			days = new Map();
			byModelDay.set(key, days);
		}
		const totals = days.get(point.timestamp) ?? { messages: 0, hits: 0 };
		totals.messages += point.messages;
		totals.hits += pointHits(point, metric);
		days.set(point.timestamp, totals);
	}

	const days = [...byDay.keys()].sort((a, b) => a - b);
	if (mode === "all") {
		const label = METRICS.find(option => option.value === metric)?.title ?? "Signals";
		return {
			days,
			series: [
				{
					key: "all",
					label,
					color: "var(--chart-primary)",
					values: days.map(day => {
						const totals = byDay.get(day)!;
						return totals.messages > 0 ? (totals.hits / totals.messages) * 100 : 0;
					}),
				},
			],
		};
	}

	const topModels = [...models.entries()].sort((a, b) => b[1].messages - a[1].messages).slice(0, MODEL_COLORS.length);
	return {
		days,
		series: topModels.map(([key, model], index) => ({
			key,
			label: model.provider ? `${model.model} · ${model.provider}` : model.model,
			color: MODEL_COLORS[index],
			kind: "line",
			values: days.map(day => {
				const totals = byModelDay.get(key)?.get(day);
				return totals ? (totals.messages > 0 ? (totals.hits / totals.messages) * 100 : 0) : null;
			}),
		})),
	};
}

function buildModelColumns(byModel: Map<string, BehaviorTimeSeriesPoint[]>): readonly Column<BehaviorModelStats>[] {
	return [
		{
			key: "model",
			header: "Model",
			render: row => (
				<div className="stack" style={{ gap: 2 }}>
					<span className="mono">{row.model}</span>
					<span className="micro muted">{row.provider}</span>
				</div>
			),
			sort: row => row.model,
			wrap: true,
		},
		{
			key: "messages",
			header: "Messages",
			align: "right",
			render: row => formatInteger(row.totalMessages),
			sort: row => row.totalMessages,
		},
		{
			key: "caps",
			header: "CAPS %",
			align: "right",
			render: row => formatRate(row.totalYelling, row.totalMessages),
			sort: row => ratio(row.totalYelling, row.totalMessages),
		},
		{
			key: "profanity",
			header: "Profanity %",
			align: "right",
			render: row => formatRate(row.totalProfanity, row.totalMessages),
			sort: row => ratio(row.totalProfanity, row.totalMessages),
		},
		{
			key: "anguish",
			header: "Anguish %",
			align: "right",
			render: row => formatRate(row.totalAnguish, row.totalMessages),
			sort: row => ratio(row.totalAnguish, row.totalMessages),
		},
		{
			key: "friction",
			header: "Friction %",
			align: "right",
			render: row => formatRate(frictionTotal(row), row.totalMessages),
			sort: row => ratio(frictionTotal(row), row.totalMessages),
		},
		{
			key: "hits",
			header: "Hits %",
			align: "right",
			render: row => formatRate(signalTotal(row), row.totalMessages),
			sort: row => ratio(signalTotal(row), row.totalMessages),
		},
		{
			key: "trend",
			header: "Trend",
			align: "center",
			render: row => (
				<Sparkline values={(byModel.get(modelKey(row)) ?? []).map(point => pointHits(point, "total"))} />
			),
		},
	];
}

function BehaviorModelDetails({ model, series }: { model: BehaviorModelStats; series: BehaviorTimeSeriesPoint[] }) {
	const days = series.map(point => point.timestamp);
	const trendSeries: ChartSeries[] = [
		{
			key: "yelling",
			label: "CAPS",
			color: SIGNAL_COLORS.yelling,
			kind: "line",
			values: series.map(point => point.yelling),
		},
		{
			key: "profanity",
			label: "Profanity",
			color: SIGNAL_COLORS.profanity,
			kind: "line",
			values: series.map(point => point.profanity),
		},
		{
			key: "anguish",
			label: "Anguish",
			color: SIGNAL_COLORS.anguish,
			kind: "line",
			values: series.map(point => point.anguish),
		},
		{
			key: "friction",
			label: "Friction",
			color: SIGNAL_COLORS.frustration,
			kind: "line",
			values: series.map(point => point.negation + point.repetition + point.blame),
		},
	];
	const detailRows = [
		["Yelling (CAPS)", model.totalYelling],
		["Profanity", model.totalProfanity],
		["Anguish", model.totalAnguish],
		["Negation", model.totalNegation],
		["Repetition", model.totalRepetition],
		["Blame", model.totalBlame],
		["Characters", model.totalChars],
	] as const;

	return (
		<div className="stack" style={{ gap: 14, padding: 16 }}>
			<div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 12 }}>
				{detailRows.map(([label, total]) => (
					<div key={label} className="stack" style={{ gap: 3 }}>
						<span className="micro muted">{label}</span>
						<span className="micro muted">
							{label === "Characters"
								? model.totalMessages > 0
									? `${formatInteger(Math.round(total / model.totalMessages))} / msg`
									: "0 / msg"
								: formatRate(total, model.totalMessages)}
						</span>
					</div>
				))}
			</div>
			{days.length > 0 && (
				<Chart
					slots={days.length}
					tickLabel={index => formatDay(days[index])}
					series={trendSeries}
					kind="line"
					stacked={false}
					height={190}
					format={formatInteger}
					formatTooltip={formatInteger}
				/>
			)}
		</div>
	);
}

function modelKey(
	value: Pick<BehaviorModelStats, "model" | "provider"> | Pick<BehaviorTimeSeriesPoint, "model" | "provider">,
): string {
	return JSON.stringify([value.model, value.provider]);
}

function pointHits(point: BehaviorTimeSeriesPoint, metric: Metric): number {
	if (metric === "frustration") return point.negation + point.repetition + point.blame;
	if (metric === "total")
		return point.yelling + point.profanity + point.anguish + point.negation + point.repetition + point.blame;
	return point[metric];
}

function signalTotal(model: BehaviorModelStats): number {
	return model.totalYelling + model.totalProfanity + model.totalAnguish + frictionTotal(model);
}

function frictionTotal(model: BehaviorModelStats): number {
	return model.totalNegation + model.totalRepetition + model.totalBlame;
}

function ratio(total: number, messages: number): number {
	return messages > 0 ? total / messages : 0;
}

function perMessage(total: number, messages: number): string | undefined {
	return messages > 0 ? `${(total / messages).toFixed(2)} / msg` : undefined;
}

function formatRate(total: number, messages: number): string {
	if (messages === 0) return "–";
	const percent = (total / messages) * 100;
	if (percent === 0) return "0%";
	return percent < 1 ? `${percent.toFixed(1)}%` : `${percent.toFixed(0)}%`;
}

function formatDay(timestamp: number, includeYear = false): string {
	return new Date(timestamp).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		...(includeYear ? { year: "numeric" } : {}),
	});
}
