You are building a product-discovery prototype for RestaurantOS Lab.

Read the attached/project file `RestaurantOS_Operator_Console_PRD.md` first and treat it as the source of truth.

Your task is to create a polished, self-contained concept prototype called:

RestaurantOS — Operator Console

IMPORTANT PRODUCT CONTEXT
This is NOT a production POS and NOT a committed MVP. It is a clickable concept prototype that I will show to an experienced restaurant operator tomorrow so we can discuss what is useful, what is unnecessary, what existing systems already solve, and what RestaurantOS should eventually become.

The concept is an operations-intelligence layer ABOVE existing restaurant systems such as Toast, Square, Clover, QuickBooks, 7shifts, vendor invoices, delivery systems, etc.

The prototype should communicate:

Existing restaurant systems
→ RestaurantOS unified operational data
→ Explain what happened
→ Predict what is likely to happen
→ Recommend what the operator should do next

DO NOT BUILD A FULL POS.

TECHNICAL REQUIREMENTS
- Deliver exactly one self-contained `index.html`
- HTML + CSS + vanilla JavaScript only
- No backend
- No npm
- No build process
- No external APIs
- Must work by double-clicking index.html
- Must work offline
- Embed all demo data directly in the file
- Avoid external dependencies/CDNs where practical
- Make the code readable and easy to modify

DESIGN
Make it look like a credible modern restaurant operations SaaS product, but keep it simple enough for an owner/operator to scan quickly.

Use:
- Left navigation
- Top header
- KPI cards
- Tables
- A few simple charts/visual indicators
- Detail drawer/modal
- Responsive laptop-friendly layout

Do NOT make it look like a generic admin template.
Do NOT overload it with 30 KPIs.
Do NOT use excessive animation.

Label it visibly:
“Concept Prototype”

Use a fictional restaurant:
“Nine Thai Kitchen”

Use realistic fictional Thai restaurant data and clearly treat it as demo data.

MAIN NAVIGATION

1. Today
2. Food Cost
3. Labor
4. Inventory & Purchasing
5. AI Operations Advisor

TODAY SCREEN
Show:
- Yesterday sales: $8,420
- Sales vs forecast: +3.2%
- Estimated food cost: 34.8%
- Food cost target: 31.5%
- Labor cost: 29.0%
- Labor target: 26.0%
- Estimated margin leakage: $410
- Tomorrow sales forecast: $9,200

Create a prominent section:
“What needs your attention today”

Include:
- Chicken usage 14% above theoretical; estimated unexplained variance $184
- Friday labor appears over-scheduled; scheduled $2,850 vs recommended $2,450; potential savings $400
- Thai basil waste 22% above four-week average; estimated impact $76

FOOD COST SCREEN
Show:
- food cost trend
- target vs actual
- actual vs theoretical usage
- vendor price changes
- waste anomalies
- recipe cost changes
- top cost drivers

Use example ingredients:
Chicken, Shrimp, Thai Basil, Rice Noodles, Coconut Milk.

Include an insight:
“About 68% of last week's food-cost increase came from chicken price increases, chicken usage variance, and higher Thai basil waste.”

LABOR SCREEN
Show:
- Tomorrow forecast sales: $9,200
- Scheduled labor: $2,850
- Recommended labor: $2,450
- Potential over-scheduling: $400

Recommendation:
“Dinner staffing appears heavy between 4:00 PM and 6:00 PM. Consider moving one server start time from 4:00 PM to 5:30 PM.”

Make clear this is a recommendation, not an automatic schedule change.

INVENTORY & PURCHASING SCREEN
Use a table like:

Chicken | 19 lb on hand | 44 lb expected need | 28 lb suggested order | Order
Shrimp | 26 lb | 21 lb | 0 | Good
Thai Basil | 3 cases | 2 cases | 0 | Overstock
Rice Noodles | 14 packs | 22 packs | 10 packs | Order
Coconut Milk | 18 cans | 16 cans | 0 | Good

Clicking Chicken should open a detail drawer/modal explaining:
- Current usable inventory: 19 lb
- Forecast requirement through Thursday: 44 lb
- Safety stock: 3 lb
- Incoming delivery: 0
- Suggested purchase: 28 lb

Show that the recommendation may consider:
forecasted menu mix, recipes, on-hand inventory, incoming orders, safety stock, waste, shelf life, and supplier schedule.

AI OPERATIONS ADVISOR
Create a realistic chat UI.

Preload example questions:
- Why were margins worse last week?
- What should I focus on this week?
- Why is chicken usage high?
- Are we overstaffed tomorrow?

For:
“Why were margins worse last week?”

Answer with:
1. Chicken and shrimp purchasing costs increased by approximately $230.
2. Friday labor ran about $310 above expected demand.
3. Waste on Thai basil and avocado increased by approximately $95.
Together these explain about 70% of the estimated margin decline.

For:
“What should I focus on this week?”

Answer:
1. Reduce Friday 4–6 PM staffing by approximately 5 labor hours.
2. Review chicken portioning because usage is running above theoretical.
3. Reduce the next Thai basil order because current stock exceeds expected demand.

CONNECTED SYSTEMS
Show a small integration area.

Connected:
- Toast POS
- QuickBooks
- 7shifts
- Vendor invoices

Future / Concept:
- Square
- Clover
- Restaurant365
- DoorDash
- Uber Eats
- Resy

Do not imply these integrations are actually implemented.

DATA MODEL / RESTAURANT REALISM
Make the demo feel like a real Thai restaurant.

Use ingredients shared across dishes:
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

Use menu examples such as Pad Thai, Pad See Ew, Basil Stir Fry, Green Curry, Fried Rice, and Drunken Noodles.

Include protein modifiers where relevant.

INTERACTIONS
Make these work:
- Navigation
- Clickable attention cards
- Ingredient detail drawer/modal
- AI prompt buttons
- Date selector or fake date control
- Optional location selector
- Tooltips/explanations where helpful

PRODUCT PRINCIPLE
The most important message is:

RestaurantOS is not another dashboard.
It should tell restaurant operators:
1. What happened
2. Why
3. What is likely to happen
4. What they should do next

CODE STRUCTURE
Inside the single HTML file, organize the JavaScript into clearly marked sections:
- Demo Data
- App State
- Navigation
- Dashboard Rendering
- Food Cost Rendering
- Labor Rendering
- Inventory Rendering
- AI Advisor
- Modals/Drawers
- Utility Functions

Before finishing:
1. Verify all navigation works.
2. Verify no external network dependency is required.
3. Verify the ingredient drawer works.
4. Verify AI sample questions work.
5. Make sure the page looks good at a normal laptop resolution.
6. Make sure “Concept Prototype” is clearly visible.
7. Do not add unrelated features just to make the demo bigger.

After creating the file, briefly summarize:
- what you built
- where the main sections are in the code
- anything I should edit before showing it to a restaurant operator
