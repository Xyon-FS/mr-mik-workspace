pub const DEFAULT_CHAT_PERCENT: f64 = 30.0;

pub fn chat_width(screen_width: f64, requested_percent: f64) -> f64 {
    let percent = if requested_percent.is_finite() && (20.0..=65.0).contains(&requested_percent) {
        requested_percent
    } else { DEFAULT_CHAT_PERCENT };
    let available = (screen_width - 4.0).max(0.0);
    let minimum = 330.0_f64.min(available);
    let maximum = (available - 500.0).max(minimum);
    (available * percent / 100.0).clamp(minimum, maximum)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_keeps_seventy_percent_for_workspace() {
        assert_eq!(chat_width(1924.0, DEFAULT_CHAT_PERCENT), 576.0);
        assert_eq!(chat_width(3844.0, DEFAULT_CHAT_PERCENT), 1152.0);
    }
    #[test]
    fn ratio_respects_both_window_minimums() {
        assert_eq!(chat_width(1204.0, 20.0), 330.0);
        assert_eq!(chat_width(1204.0, 65.0), 700.0);
        assert_eq!(chat_width(1924.0, 40.0), 768.0);
    }
    #[test]
    fn invalid_ratios_use_the_default() {
        for ratio in [f64::NAN, f64::INFINITY, -1.0, 100.0] {
            assert_eq!(chat_width(1924.0, ratio), 576.0);
        }
    }
}
