// ============================================================
// securities / security_tags / daily_quotes / tech_indicators /
// money_flow / auction_data / limit_records / hot_sectors 查询
// ============================================================

// ------------------------------------------------------------
// SQLite 单条语句的绑定变量上限（SQLITE_LIMIT_VARIABLE_NUMBER）：
// 旧版本为 999，3.32+ 默认 32766。全市场 universe 已达 4.7 万只，
// 直接把 codes 展开进 IN (...) 会触发 "too many SQL variables"。
// 统一走分批查询，取保守批大小以兼容所有驱动。
// ------------------------------------------------------------
const IN_CHUNK_SIZE = 500;

function chunk(arr, size = IN_CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 分批执行含 IN (...) 的查询并合并结果，规避绑定变量上限。
 * @param {import('../db/driver.js').Database} db
 * @param {string[]} codes 参与 IN 的取值
 * @param {(placeholders: string) => string} buildSql 由占位符串构造 SQL
 * @returns {object[]} 合并后的行
 */
function selectByCodes(db, codes, buildSql) {
  const rows = [];
  for (const batch of chunk(codes)) {
    const placeholders = batch.map(() => '?').join(',');
    rows.push(...db.all(buildSql(placeholders), batch));
  }
  return rows;
}

/**
 * 证券模型工厂（含行情/指标/资金/竞价/涨停/板块等查询）
 * @param {import('../db/driver.js').Database} db
 */
export function createSecurityModel(db) {
  return {
    // ---------- securities ----------
    list(filter = {}) {
      const { types, excludeST = false, excludeNew = false, sectors, minMv, maxMv, minPrice, maxPrice, q } = filter;
      const where = [];
      const params = [];
      if (types && types.length) {
        where.push(`type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
      if (excludeST) {
        where.push('is_st = 0');
      }
      if (excludeNew) {
        where.push(`(julianday('now') - julianday(list_date)) >= 60`);
      }
      if (sectors && sectors.length) {
        where.push(`sector IN (${sectors.map(() => '?').join(',')})`);
        params.push(...sectors);
      }
      if (minMv !== undefined && minMv !== null) { where.push('circ_mv >= ?'); params.push(minMv); }
      if (maxMv !== undefined && maxMv !== null) { where.push('circ_mv <= ?'); params.push(maxMv); }
      if (minPrice !== undefined && minPrice !== null) { where.push('price_latest >= ?'); params.push(minPrice); }
      if (maxPrice !== undefined && maxPrice !== null) { where.push('price_latest <= ?'); params.push(maxPrice); }
      if (q) { where.push('(code LIKE ? OR name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

      const sql = `
        SELECT s.*, dq.close AS price_latest, dq.pre_close AS pre_close_latest,
               dq.pct_chg AS pct_chg_latest, dq.turnover_rate AS turnover_latest,
               dq.volume_ratio AS volume_ratio_latest, dq.amount AS amount_latest,
               dq.trade_date AS quote_date
        FROM securities s
        LEFT JOIN daily_quotes dq ON dq.code = s.code AND dq.trade_date = (
          SELECT MAX(trade_date) FROM daily_quotes WHERE code = s.code
        )
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY s.code
      `;
      return db.all(sql, params);
    },

    findByCode(code) {
      return db.get('SELECT * FROM securities WHERE code = ?', [code]);
    },

    findById(id) {
      return db.get('SELECT * FROM securities WHERE id = ?', [id]);
    },

    search(q, limit = 10) {
      return db.all(
        `SELECT code, name, type, sector, industry FROM securities
         WHERE code LIKE ? OR name LIKE ?
         ORDER BY (code = ?) DESC, code
         LIMIT ?`,
        [`%${q}%`, `%${q}%`, q, limit],
      );
    },

    count(filter = {}) {
      const { types } = filter;
      if (types && types.length) {
        return db.get(`SELECT COUNT(*) AS n FROM securities WHERE type IN (${types.map(() => '?').join(',')})`, types).n;
      }
      return db.get('SELECT COUNT(*) AS n FROM securities').n;
    },

    /** 最新交易日 */
    latestTradeDate() {
      const r = db.get('SELECT MAX(trade_date) AS d FROM daily_quotes');
      return r?.d || null;
    },

    // ---------- security_tags ----------
    listTags(codes) {
      if (!codes || codes.length === 0) return [];
      const rows = selectByCodes(db, codes, (ph) =>
        `SELECT code, tag FROM security_tags WHERE code IN (${ph})`);
      const map = {};
      for (const r of rows) {
        if (!map[r.code]) map[r.code] = [];
        map[r.code].push(r.tag);
      }
      return map;
    },

    // ---------- daily_quotes ----------
    getLatestQuote(code) {
      return db.get(
        `SELECT * FROM daily_quotes WHERE code = ? ORDER BY trade_date DESC LIMIT 1`,
        [code],
      );
    },

    getQuotes(codes) {
      if (!codes || codes.length === 0) return [];
      return selectByCodes(db, codes, (ph) =>
        `SELECT dq.*, s.name, s.type, s.sector, s.industry, s.circ_mv, s.total_mv, s.pe_ttm AS sec_pe, s.dividend_yield
         FROM daily_quotes dq
         JOIN securities s ON s.code = dq.code
         WHERE dq.code IN (${ph})
           AND dq.trade_date = (SELECT MAX(trade_date) FROM daily_quotes)`,
      ).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    },

    getKline(code, days = 120) {
      return db.all(
        `SELECT code, trade_date, open, high, low, close, pre_close, volume, amount, pct_chg, turnover_rate, volume_ratio, data_origin
         FROM daily_quotes WHERE code = ?
         ORDER BY trade_date DESC LIMIT ?
         `,
        [code, days],
      ).reverse();
    },

    // ---------- tech_indicators ----------
    getLatestIndicators(codes) {
      if (!codes || codes.length === 0) return [];
      return selectByCodes(db, codes, (ph) =>
        `SELECT ti.* FROM tech_indicators ti
         WHERE ti.code IN (${ph})
           AND ti.trade_date = (SELECT MAX(trade_date) FROM tech_indicators WHERE code = ti.code)`);
    },

    getIndicatorSeries(code, days = 120) {
      return db.all(
        `SELECT * FROM tech_indicators WHERE code = ? ORDER BY trade_date DESC LIMIT ?`,
        [code, days],
      ).reverse();
    },

    // ---------- money_flow ----------
    getMoneyFlow(codes) {
      if (!codes || codes.length === 0) return [];
      return selectByCodes(db, codes, (ph) =>
        `SELECT * FROM money_flow WHERE code IN (${ph})
           AND trade_date = (SELECT MAX(trade_date) FROM money_flow)`);
    },

    // ---------- auction_data ----------
    getAuctionData(codes) {
      if (!codes || codes.length === 0) return [];
      return selectByCodes(db, codes, (ph) =>
        `SELECT * FROM auction_data WHERE code IN (${ph})
           AND trade_date = (SELECT MAX(trade_date) FROM auction_data)`);
    },

    /** 竞价榜 TopN（按竞价涨幅降序） */
    auctionLeaderboard(top = 60) {
      return db.all(
        `SELECT a.code, s.name, s.circ_mv, a.auction_pct, a.auction_vol_ratio, a.first_trade_vol_ratio,
                dq.volume_ratio, dq.pct_chg, dq.turnover_rate
         FROM auction_data a
         JOIN securities s ON s.code = a.code
         LEFT JOIN daily_quotes dq ON dq.code = a.code AND dq.trade_date = a.trade_date
         WHERE a.trade_date = (SELECT MAX(trade_date) FROM auction_data)
         ORDER BY a.auction_pct DESC
         LIMIT ?`,
        [top],
      );
    },

    // ---------- limit_records ----------
    getLimitRecords(codes) {
      if (!codes || codes.length === 0) return [];
      // 分批后需重新全局排序（各批内有序不代表合并后有序）
      return selectByCodes(db, codes, (ph) =>
        `SELECT * FROM limit_records WHERE code IN (${ph})`)
        .sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
    },

    getLatestLimitUp(codes) {
      if (!codes || codes.length === 0) return [];
      return selectByCodes(db, codes, (ph) =>
        `SELECT * FROM limit_records WHERE code IN (${ph})
           AND trade_date = (SELECT MAX(trade_date) FROM limit_records)`)
        .sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
    },

    countLimitUpToday() {
      const d = this.latestTradeDate();
      if (!d) return 0;
      return db.get(
        `SELECT COUNT(DISTINCT code) AS n FROM limit_records WHERE trade_date = ? AND limit_type = 'limit_up'`,
        [d],
      ).n;
    },

    // ---------- hot_sectors ----------
    getHotSectors(dimension = 'sector', top = 20) {
      return db.all(
        `SELECT * FROM hot_sectors WHERE dimension = ?
         ORDER BY hot_rank ASC LIMIT ?`,
        [dimension, top],
      );
    },

    getSectorHeat(sector) {
      return db.get(
        `SELECT * FROM hot_sectors WHERE dimension = 'sector' AND sector_name = ?
         ORDER BY trade_date DESC LIMIT 1`,
        [sector],
      );
    },

    // ---------- 组合快照 ----------
    /** 全市场当日快照（供分位评分池） */
    getLatestSnapshot(types = ['stock']) {
      return db.all(
        `SELECT dq.code, dq.close, dq.pct_chg, dq.turnover_rate, dq.volume_ratio, dq.amount,
                s.circ_mv, s.sector, s.industry, s.type
         FROM daily_quotes dq
         JOIN securities s ON s.code = dq.code
         WHERE dq.trade_date = (SELECT MAX(trade_date) FROM daily_quotes)
           AND s.type IN (${types.map(() => '?').join(',')})
        `,
        types,
      );
    },

    /** 市场概览统计 */
    overview() {
      const d = this.latestTradeDate();
      const stockCount = this.count({ types: ['stock'] });
      const fundCount = this.count({ types: ['fund'] });
      const totalCount = this.count();
      if (!d) {
        return { trade_date: null, stock_count: stockCount, fund_count: fundCount, total_count: totalCount, up_count: 0, down_count: 0, limit_up_count: 0, avg_pct_chg: 0 };
      }
      const stat = db.get(
        `SELECT
           SUM(CASE WHEN dq.pct_chg > 0 THEN 1 ELSE 0 END) AS up_count,
           SUM(CASE WHEN dq.pct_chg < 0 THEN 1 ELSE 0 END) AS down_count,
           ROUND(AVG(dq.pct_chg), 2) AS avg_pct_chg
         FROM daily_quotes dq
         WHERE dq.trade_date = ?`,
        [d],
      );
      return {
        trade_date: d,
        stock_count: stockCount,
        fund_count: fundCount,
        total_count: totalCount,
        up_count: stat?.up_count || 0,
        down_count: stat?.down_count || 0,
        limit_up_count: this.countLimitUpToday(),
        avg_pct_chg: stat?.avg_pct_chg || 0,
      };
    },
  };
}
