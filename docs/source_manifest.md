# Source Manifest — SolarPulse AI

Use this file as the factual anchor list for the build and pitch. Do not overclaim beyond these sources.

## Competition

- MAIC home: https://maicnexus.com/en
- MAIC tracks: https://maicnexus.com/en/tracks
  - T1 Clean Energy includes project development intelligence, smart grid integration, clean energy asset monitoring, long term yield forecasting, and clean energy solutions.
- MAIC apply/rubric: https://maicnexus.com/en/register
  - Required materials: pitch deck PDF max 12 slides, project summary max 500 words, AI disclosure, optional demo video and artifact link.
  - Preliminary rubric: technical feasibility 25%, commercial viability 25%, industry relevance 20%, scalability 15%, ESG/national impact 15%.
- MAIC terms: https://maicnexus.com/en/terms
  - Public artifact access during judging.
  - Repo artifacts need at least 3 commits over 2 calendar days.
  - Industry selection is locked.

## Malaysia clean-energy context

- MIDA NETR overview: https://www.mida.gov.my/national-energy-transition-roadmap-netr-charting-a-path-to-a-sustainable-energy-landscape/
  - Net zero 2050.
  - Renewable energy share targets: 31% by 2025, 40% by 2035, 70% by 2050.
  - NETR focus levers include energy efficiency, renewable energy, hydrogen, bioenergy, green mobility, and CCUS.

## Public energy data

- Single Buyer demand data: https://www.singlebuyer.com.my/market/market-data/demand
  - Daily 30-minute and week-ahead 1-hour operational demand forecasts for Peninsular Malaysia.
  - Annual demand and energy records.
  - 10-year demand outlook.
- OpenDOSM electricity supply: https://open.dosm.gov.my/data-catalogue/electricity_supply
  - Monthly electricity supply by sector.
  - CSV, parquet, Open API.
  - CC BY 4.0.
- OpenDOSM electricity consumption: https://open.dosm.gov.my/data-catalogue/electricity_consumption
  - Monthly electricity consumption by sector.
  - CSV, parquet, Open API.
  - CC BY 4.0.
- MyEnergyStats: https://myenergystats.st.gov.my/
  - National energy database managed by the Energy Commission of Malaysia.

## Solar partner / market context

- Solarvest: https://solarvest.com/
  - Integrated solar provider; large-scale, commercial & industrial, residential, energy efficiency, RECs, EV charging, AIoT, BESS, and asset management are product/service categories.
  - Useful ICP/partner proxy for SolarPulse.

## Technical references

- NREL PVDAQ: https://data.openei.org/submissions/4568
  - Public PV time-series datasets with system metadata, performance data, environmental sensors, degradation/soiling relevance.
- pvlib-python: https://pvlib-python.readthedocs.io/en/stable/
  - Open PV modeling toolbox for simulating PV system performance.
- NREL PV & Energy Storage O&M Best Practices, 3rd edition: https://www.nrel.gov/docs/fy19osti/73822.pdf
  - Monitoring should compare system results to benchmark expectations and report plant performance, KPIs, problems, alarms, and maintenance services.
  - Monitoring data analysis is powerful but limited by sensor/model quality.
  - Active plant monitoring, accurate performance measurements, issue pinpointing, and prompt repair are essential.

## Source use policy

Every generated demo report must state whether each datapoint is:
- public source,
- open benchmark data,
- fixture/synthetic data,
- partner-provided data,
- model estimate,
- manual assumption.
