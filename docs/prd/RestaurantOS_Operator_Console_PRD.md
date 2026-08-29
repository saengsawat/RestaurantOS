# RestaurantOS Lab — Operator Console Concept Prototype
## Product Requirements Document (PRD)

**Document status:** Draft / Discovery Prototype  
**Version:** 0.1  
**Purpose:** Build a self-contained, clickable HTML concept prototype for discussion with restaurant operators and potential collaborators.  
**Important:** This is **not** a committed MVP specification and **not** a production POS. It is a product-discovery artifact.

---

# 1. Product Context

RestaurantOS Lab is exploring an AI-powered restaurant operations platform that connects operational data from systems such as POS, inventory, purchasing, labor, accounting, delivery, and reservations.

The long-term idea is broader than a traditional POS. The platform should help restaurant owners understand:

- What happened?
- Why did it happen?
- What is likely to happen next?
- What should we do?
- Eventually, what can the system do automatically?

The current discovery hypothesis is that RestaurantOS may work best as an **operations intelligence layer above existing restaurant systems**, rather than replacing the POS in the first version.

This prototype should make that concept tangible without prematurely committing to a specific product architecture or feature set.

---

# 2. Goal of This Prototype

Create a polished, realistic, clickable concept prototype that can be shown to restaurant operators and collaborators.

The prototype should help answer:

1. Which information would a restaurant owner actually look at every day?
2. Which recommendations feel valuable versus unnecessary?
3. Which operational pain points matter most?
4. Which workflows are already solved well by existing systems?
5. What data would be required to make the recommendations trustworthy?
6. Which concepts deserve further validation before an MVP is designed?

The prototype is a **conversation tool**, not a sales demo.

---

# 3. Non-Goals

The prototype should **not**:

- Process real payments
- Implement a production POS
- Include real authentication
- Call external APIs
- Use a backend
- Persist real data
- Implement production AI models
- Implement real forecasting
- Implement accounting logic
- Attempt PCI compliance
- Be presented as production-ready software

Do not spend time recreating Toast, Square, Clover, or Restaurant365.

---

# 4. Primary User

## Initial Persona

**Independent / small-group restaurant owner or operator**

Typical characteristics:

- 1–5 locations
- Full-service or operationally complex restaurant
- Existing POS
- Uses some combination of accounting, payroll, labor, delivery, inventory, and spreadsheets
- Does not have a strong unified operational intelligence layer
- Cares heavily about food cost, labor cost, cash flow, waste, and margin
- Has limited time to analyze reports

The first real-world discovery environment is expected to be a full-service Thai restaurant similar to At Nine Restaurant & Bar in NYC.

The prototype may use a fictional Thai restaurant to make ingredient-sharing, modifiers, recipes, and purchasing examples realistic.

---

# 5. Product Positioning for the Prototype

Use the following framing:

> RestaurantOS helps restaurant operators understand what is happening, why it is happening, and what they should do next — without requiring them to replace every system they already use.

The prototype should visually reinforce:

**Existing Systems → RestaurantOS → Insights / Forecasts / Recommendations**

Possible connected systems shown in the UI:

- Toast
- Square
- Clover
- QuickBooks
- 7shifts
- Vendor invoices
- Delivery platforms
- Reservation systems

These are illustrative only.

---

# 6. Core Prototype Sections

The prototype should contain five main sections accessible from a left navigation, top navigation, or tab structure.

---

## 6.1 Today / Operator Dashboard

### Purpose
Give the owner a concise morning view of the business.

### Example Metrics

- Yesterday sales: **$8,420**
- Sales vs forecast: **+3.2%**
- Estimated food cost: **34.8%**
- Food cost target: **31.5%**
- Labor cost: **29.0%**
- Labor target: **26.0%**
- Estimated margin leakage: **$410**
- Tomorrow sales forecast: **$9,200**

### Main Content

Include a section titled:

**What needs your attention today**

Example cards:

1. **Chicken usage above expected**
   - Actual usage is 14% above theoretical usage
   - Estimated unexplained variance: $184

2. **Friday labor appears over-scheduled**
   - Scheduled labor: $2,850
   - Recommended labor: $2,450
   - Potential savings: $400

3. **Thai basil waste increased**
   - Waste is 22% above the recent four-week average
   - Estimated impact: $76

### UX Goal

The owner should be able to understand the business situation in under 30 seconds.

Avoid showing too many charts.

---

## 6.2 Food Cost

### Purpose
Explain where food cost is changing and why.

### Include

- Current food cost percentage
- Food cost target
- 7-day and 30-day trend
- Actual vs theoretical usage
- Vendor price changes
- Recipe cost changes
- Waste anomalies
- High-impact ingredients

### Example Findings

**Chicken**
- Vendor price: +11%
- Actual usage: +14% above theoretical
- Estimated weekly impact: $184

**Shrimp**
- Vendor price: +6.5%
- Usage within normal range

**Thai Basil**
- Waste: +22% vs four-week average

### Suggested Insight

> About 68% of last week's food-cost increase came from chicken price increases, chicken usage variance, and higher Thai basil waste.

### Optional Visuals

- Food cost trend line
- Variance bar chart
- Top cost drivers table

Keep the visuals simple and executive-friendly.

---

## 6.3 Labor

### Purpose
Show whether labor aligns with expected demand.

### Include

- Tomorrow sales forecast
- Scheduled labor cost
- Recommended labor cost
- Labor percentage
- Potential over/under staffing
- Suggested changes

### Example

**Tomorrow**
- Forecast sales: $9,200
- Scheduled labor: $2,850
- Recommended labor: $2,450
- Potential over-scheduling: $400

### Suggested Recommendation

> Dinner staffing appears heavy between 4:00 PM and 6:00 PM. Consider moving one server start time from 4:00 PM to 5:30 PM.

### Important

Do not make the system look like it automatically changes employee schedules.

This prototype should show recommendations only.

**How this pillar gets real numbers:** the staircase from today's clock-ins to a labor line the operator can trust is specified in [team-labor-spec.md](team-labor-spec.md) per decision D28. Three rungs: the people directory (job title separate from permission level, home contact details manager-gated), scheduling (planned shifts against the actual clock records, so planned-versus-actual hours becomes this screen's first true line item), and payroll, which RestaurantOS never computes. Hours and declared tips export as CSV for a payroll provider, the payments posture applied to labor.

---

## 6.4 Inventory & Purchasing

### Purpose
Show how RestaurantOS could move from demand forecasting to actionable purchasing guidance.

### Example Ingredient Table

| Ingredient | On Hand | Expected Need | Suggested Order | Status |
|---|---:|---:|---:|---|
| Chicken | 19 lb | 44 lb | 28 lb | Order |
| Shrimp | 26 lb | 21 lb | 0 lb | Good |
| Thai Basil | 3 cases | 2 cases | 0 | Overstock |
| Rice Noodles | 14 packs | 22 packs | 10 packs | Order |
| Coconut Milk | 18 cans | 16 cans | 0 | Good |

### Include Factors

Illustratively show that recommendations may consider:

- Forecasted menu mix
- Recipe ingredient requirements
- Current inventory
- Incoming orders
- Safety stock
- Waste
- Shelf life
- Supplier delivery schedule

### Detail Drawer / Modal

Clicking an ingredient should show something like:

**Chicken recommendation explanation**

- Current usable inventory: 19 lb
- Forecast requirement through Thursday: 44 lb
- Safety stock: 3 lb
- Incoming delivery: 0 lb
- Suggested purchase: 28 lb

The purpose is to show that recommendations are explainable, not a black box.

---

## 6.5 AI Operations Advisor

### Purpose
Demonstrate a natural-language layer on top of deterministic restaurant data and analytics.

### Example Conversation 1

**Owner:**  
Why were margins worse last week?

**RestaurantOS:**  
The largest contributors were:

1. Chicken and shrimp purchasing costs increased by approximately $230.
2. Friday labor ran about $310 above expected demand.
3. Waste on Thai basil and avocado increased by approximately $95.

Together, these explain about 70% of the estimated margin decline.

### Example Conversation 2

**Owner:**  
What should I focus on this week?

**RestaurantOS:**

1. Reduce Friday 4–6 PM staffing by approximately 5 labor hours.
2. Review chicken portioning because usage is running above theoretical.
3. Reduce the next Thai basil order because current stock exceeds expected demand.

### Important AI Principle

The prototype should imply this architecture:

- Database = source of truth
- Deterministic logic = calculations
- Forecasting / ML = predictions
- LLM / AI advisor = explanation and interface

The AI should never appear to invent financial or inventory numbers.

---

# 7. Connected Systems Area

Include a compact area showing example integrations.

Example:

**Connected**
- Toast POS
- QuickBooks
- 7shifts
- Vendor invoices

**Available / Future**
- Square
- Clover
- Restaurant365
- DoorDash
- Uber Eats
- Resy

The purpose is to communicate that RestaurantOS may sit above existing systems.

Do not imply that every integration is already implemented.

Use labels such as:

- Connected
- Concept
- Available in future
- Demo data

---

# 8. Restaurant Demo Data

Use a fictional restaurant.

Suggested name:

**Nine Thai Kitchen**

Profile:

- Full-service Thai restaurant
- One location
- Approx. $1.8M annual revenue
- Food cost target: 31–32%
- Labor target: 25–27%
- Mix of dine-in, takeout, and delivery

Include shared ingredients common to a Thai restaurant:

- Chicken
- Shrimp
- Beef
- Tofu
- Thai basil
- Coconut milk
- Rice noodles
- Jasmine rice
- Cooking oil
- Bell peppers
- Onions
- Cilantro
- Lime
- Avocado
- Curry paste
- Pad Thai sauce

Include protein modifiers and ingredient reuse across dishes.

The data must be clearly fictional/demo data.

---

# 9. Interaction Requirements

The prototype should feel clickable and real.

At minimum:

- Navigation between all five sections
- Clickable cards
- Ingredient detail modal or side drawer
- AI Advisor conversation interaction
- Date selector or mock date control
- Optional location selector
- Tooltips or small explanatory text where helpful

No backend is required.

Use JavaScript state and static JSON/mock objects.

---

# 10. Design Requirements

## Style

- Modern
- Clean
- Operational
- Restaurant-focused
- Professional but not enterprise-heavy
- Easy to scan
- Suitable for laptop presentation

Avoid:

- Overly flashy gradients
- Excessive animation
- Dense enterprise dashboards
- Too many colors
- Tiny text
- Dozens of KPIs on one screen

## Layout

Recommended:

- Left navigation
- Top bar with restaurant name / date
- KPI summary cards
- Main content area
- Responsive enough to work on a laptop and tablet

## Branding

Working product name:

**RestaurantOS**

Prototype subtitle:

**Operator Console**

Visible badge:

**Concept Prototype**

Optional message:

> Turn restaurant data into daily decisions.

---

# 11. Technical Requirements

Build as:

**One self-contained `index.html` file**

Requirements:

- HTML
- CSS
- Vanilla JavaScript
- No backend
- No npm install
- No build step
- No external API calls
- Should open directly in Chrome/Edge
- Must work offline
- All demo data embedded in the file

External CDN libraries should be avoided if possible so the prototype remains fully self-contained.

If charts are needed, prefer simple CSS/SVG/Canvas implementations rather than dependencies.

---

# 12. Code Quality Requirements

Even though this is only a prototype:

- Organize demo data separately from rendering logic
- Use reusable rendering functions
- Keep navigation logic simple
- Comment major sections
- Avoid one enormous unreadable JavaScript block
- Use semantic HTML where practical
- Keep the code easy to modify after operator feedback

Suggested internal sections:

```text
Demo Data
App State
Navigation
Dashboard Rendering
Food Cost Rendering
Labor Rendering
Inventory Rendering
AI Advisor Rendering
Modal / Drawer Components
Utility Functions
```

---

# 13. Discovery Questions the Prototype Should Trigger

The prototype is successful if it causes operators to answer questions such as:

1. Which screen would you look at first every morning?
2. Which recommendation would actually cause you to change something?
3. What feels unnecessary?
4. What information do you already get from your current systems?
5. What is still missing today?
6. What decisions are hardest to make?
7. Which numbers do you not trust today?
8. How do you currently decide how much to order?
9. How do you decide labor levels?
10. How do you identify food-cost problems?
11. How much manual work goes into inventory and recipe maintenance?
12. What would you pay to have automated?
13. What would have to be true for you to trust an automated recommendation?

---

# 14. Prototype Success Criteria

This concept prototype is successful if:

- A restaurant operator understands the concept in under five minutes
- The operator can identify at least one high-value problem
- The discussion reveals which features are useful versus unnecessary
- The operator identifies missing workflows or data
- We learn which recommendations they would trust
- We identify data required for a real pilot
- We learn whether the product should focus first on food cost, labor, purchasing, daily financial intelligence, or another area

The success metric is **learning**, not visual polish.

---

# 15. Questions Still Open

Do not answer these in the prototype. They are discovery questions:

- What should the first MVP actually be?
- Which POS should be integrated first?
- Should RestaurantOS support inventory directly or integrate with another inventory system?
- How much recipe-level setup is acceptable?
- Can onboarding be automated with AI?
- Which recommendations create measurable ROI?
- How much will restaurants pay?
- Which restaurant segment has the strongest unmet need?
- Should labor be part of V1?
- Should RestaurantOS eventually build its own POS?
- Which existing systems should be replaced versus integrated?
- How much human advisory service should accompany the software initially?

---

# 16. Future Direction — Not Required for This Prototype

Possible long-term progression:

```text
Observe
   ↓
Explain
   ↓
Predict
   ↓
Recommend
   ↓
Automate
```

Possible future capabilities:

- Automated invoice ingestion
- Recipe digitization
- Ingredient/vendor normalization
- Actual vs theoretical inventory
- Demand forecasting
- Purchase-order generation
- Prep recommendations
- Labor forecasting
- Margin anomaly detection
- Multi-location benchmarking
- Daily financial close
- Operator alerts
- Approval-based automated actions
- Guest intelligence (the guestbook): per-guest favorites, spend, visit cadence, preferred section and server, specified in [guestbook-spec.md](guestbook-spec.md) as a Phase 6 addition sourced from competitor observation (Lightspeed Restaurant's Guestbook), identity ladder per decision D20
- Migration and onboarding: bringing a restaurant off its old POS (menu, staff, floor, guests), specified in [migration-spec.md](migration-spec.md), spec-only per decision D26 until a real customer export exists
- Reservations: the staff-entered call-in book, floor badges that warn rather than lock, and seating that prefills covers and feeds the guestbook's phone rung, specified in [reservations-spec.md](reservations-spec.md) per decision D27; online booking stays integrate-never-build

These are **not commitments**.

---

# 17. Final Product Principle

The prototype should communicate one core idea:

> RestaurantOS is not another dashboard. It should help the operator decide what to do next.

The product should focus on actionable operational decisions rather than simply displaying more restaurant data.
