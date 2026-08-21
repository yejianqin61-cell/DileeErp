const TEST_ROLE_KEYS = ["sales_operator", "procurement_operator", "warehouse_operator", "finance_operator", "administrator"];

function testUser(username, roleKey) {
  if (!TEST_ROLE_KEYS.includes(roleKey)) throw new Error(`Unsupported test role: ${roleKey}`);
  return { username, display_name: `测试-${roleKey}`, role_key: roleKey };
}

module.exports = { TEST_ROLE_KEYS, testUser };
