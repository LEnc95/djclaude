package importers

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// WikipediaCharts scrapes the year-end Billboard Hot 100 page on Wikipedia.
// Wikipedia tables are stable and the rendered HTML is friendly; we avoid
// the parsoid/mediawiki API and just grep the rendered article.
//
// URL pattern: https://en.wikipedia.org/wiki/Billboard_Year-End_Hot_100_singles_of_YEAR
type WikipediaCharts struct{}

func NewWikipediaCharts() *WikipediaCharts { return &WikipediaCharts{} }

func (*WikipediaCharts) Name() string { return "wikipedia" }

// Find: `query` is the year as a string ("1985"). Limit caps the rows returned.
func (*WikipediaCharts) Find(ctx context.Context, query string, limit int) ([]Candidate, error) {
	year, err := strconv.Atoi(strings.TrimSpace(query))
	if err != nil || year < 1946 || year > 2099 {
		return nil, fmt.Errorf("year must be a 4-digit integer between 1946 and 2099")
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	url := fmt.Sprintf(
		"https://en.wikipedia.org/wiki/Billboard_Year-End_Hot_100_singles_of_%d", year)

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("User-Agent", "djclaude-pro/0.1")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("wikipedia %d → HTTP %d", year, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return parseChartTable(string(body), year, limit), nil
}

// Wikipedia renders the chart as a <table class="wikitable sortable">.
// Rows are: <tr><td>RANK</td><td><i>"Song Title"</i> or "Song Title"</td><td><a>Artist</a></td></tr>
// We use a tolerant regex pass rather than a full HTML parser to avoid
// pulling in goquery. If Wikipedia ever changes the layout meaningfully
// we'll fail gracefully (return empty list) rather than panic.
var (
	rowRE   = regexp.MustCompile(`(?is)<tr>\s*<td[^>]*>\s*(\d+)\s*</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>`)
	tagRE   = regexp.MustCompile(`<[^>]+>`)
	quoteRE = regexp.MustCompile(`^["“”']+|["“”']+$`)
	wsRE    = regexp.MustCompile(`\s+`)
)

func parseChartTable(html string, year, limit int) []Candidate {
	out := []Candidate{}
	for _, m := range rowRE.FindAllStringSubmatch(html, -1) {
		if len(m) < 4 {
			continue
		}
		rank, _ := strconv.Atoi(m[1])
		if rank == 0 {
			continue
		}
		title := cleanHTMLText(m[2])
		artist := cleanHTMLText(m[3])
		if title == "" || artist == "" {
			continue
		}
		y := year
		out = append(out, Candidate{Title: title, Artist: artist, Year: &y})
		if len(out) >= limit {
			break
		}
	}
	return out
}

func cleanHTMLText(s string) string {
	// Replace common &-encoded entities first; full entity unescape would
	// need html.UnescapeString but we pay a small fidelity cost for fewer deps.
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&nbsp;", " ")
	s = strings.ReplaceAll(s, "&quot;", `"`)
	s = strings.ReplaceAll(s, "&#39;", "'")
	s = tagRE.ReplaceAllString(s, " ")
	s = wsRE.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	s = quoteRE.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}
