import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { NEXT_THEME_PREFERENCE, type ThemePreference, useThemePreference } from "../../lib/theme";

const PREFERENCE_ICON: Record<ThemePreference, LucideIcon> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
};

export function ThemeToggle() {
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];

	return (
		<button
			type="button"
			className="sh-icon-btn"
			onClick={() => setPreference(NEXT_THEME_PREFERENCE[preference])}
			aria-label={`${PREFERENCE_LABEL[preference]} (click to switch)`}
			title={`${PREFERENCE_LABEL[preference]} — click to switch`}
		>
			<Icon size={16} />
		</button>
	);
}
