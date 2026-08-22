# Task 03：F3 工资支付与核销

新增 `SalaryPayment`、`SalaryPaymentAllocation`，实现工资付款草稿、过账、分批/多对多核销、付款冲销和台账状态刷新。

阻止付款超额、台账超额、员工或币种不匹配；已确认台账存在有效付款时禁止直接冲销。

