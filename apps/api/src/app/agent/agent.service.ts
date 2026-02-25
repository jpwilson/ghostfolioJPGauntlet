import { OrderService } from '@ghostfolio/api/app/order/order.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { SymbolService } from '@ghostfolio/api/app/symbol/symbol.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { CoreMessage, generateText, tool } from 'ai';
import { z } from 'zod';

@Injectable()
export class AgentService {
  public constructor(
    private readonly orderService: OrderService,
    private readonly portfolioService: PortfolioService,
    private readonly prismaService: PrismaService,
    private readonly symbolService: SymbolService
  ) {}

  // --- Conversation CRUD ---

  public async listConversations({ userId }: { userId: string }) {
    const conversations = await this.prismaService.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } }
      }
    });

    return { conversations };
  }

  public async getConversation({
    conversationId,
    userId
  }: {
    conversationId: string;
    userId: string;
  }) {
    const conversation = await this.prismaService.conversation.findFirst({
      where: { id: conversationId, userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            role: true,
            content: true,
            toolCalls: true,
            createdAt: true
          }
        }
      }
    });

    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    return { conversation };
  }

  public async deleteConversation({
    conversationId,
    userId
  }: {
    conversationId: string;
    userId: string;
  }) {
    await this.prismaService.conversation.deleteMany({
      where: { id: conversationId, userId }
    });

    return { success: true };
  }

  // --- Chat with persistence ---

  public async chat({
    conversationId,
    messages,
    userId
  }: {
    conversationId?: string;
    messages: CoreMessage[];
    userId: string;
  }) {
    // Create or get conversation
    let convId = conversationId;

    if (!convId) {
      const firstUserMsg = messages.find((m) => m.role === 'user');
      const title =
        typeof firstUserMsg?.content === 'string'
          ? firstUserMsg.content.slice(0, 100)
          : 'New conversation';

      const conversation = await this.prismaService.conversation.create({
        data: { userId, title }
      });
      convId = conversation.id;
    }

    // Save the latest user message
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'user') {
      await this.prismaService.message.create({
        data: {
          conversationId: convId,
          role: 'user',
          content:
            typeof lastMessage.content === 'string'
              ? lastMessage.content
              : JSON.stringify(lastMessage.content)
        }
      });
    }

    // Collect tool results for verification
    const toolResults: Array<{ tool: string; result: any }> = [];

    const result = await generateText({
      model: openai('gpt-4o-mini'),
      system: `You are a helpful financial assistant for Ghostfolio, a portfolio management app.
You help users understand their investments by analyzing their portfolio, looking up market data, and reviewing their transaction history.
Always be factual and precise with numbers. If you don't have enough data to answer, say so.
When discussing financial topics, include appropriate caveats that this is not financial advice.
When presenting numerical data, always include the currency (e.g., USD).
If you detect any inconsistencies in the data, flag them clearly to the user.`,
      messages,
      tools: {
        portfolio_summary: tool({
          description:
            'Get the current portfolio holdings with allocation percentages, asset classes, and performance. Use this when the user asks about their portfolio, holdings, allocation, diversification, or how their investments are doing.',
          parameters: z.object({}),
          execute: async () => {
            try {
              const details = await this.portfolioService.getDetails({
                filters: [],
                impersonationId: undefined,
                userId
              });

              const holdings = Object.values(details.holdings).map(
                (holding) => ({
                  name: holding.name,
                  symbol: holding.symbol,
                  currency: holding.currency,
                  assetClass: holding.assetClass,
                  assetSubClass: holding.assetSubClass,
                  allocationInPercentage: (
                    holding.allocationInPercentage * 100
                  ).toFixed(2),
                  marketPrice: holding.marketPrice,
                  quantity: holding.quantity,
                  valueInBaseCurrency: holding.valueInBaseCurrency
                })
              );

              const result = {
                success: true,
                holdings,
                summary: details.summary
              };
              toolResults.push({ tool: 'portfolio_summary', result });
              return result;
            } catch (error) {
              return {
                success: false,
                error: `Failed to fetch portfolio: ${error.message}`
              };
            }
          }
        }),

        market_data: tool({
          description:
            'Look up current market data for a stock, ETF, or cryptocurrency by searching for its name or symbol. Use this when the user asks about current prices, what a stock is trading at, or wants to look up a specific asset.',
          parameters: z.object({
            query: z
              .string()
              .describe(
                'The stock symbol or company name to search for (e.g. "AAPL", "Apple", "VTI")'
              )
          }),
          execute: async ({ query }) => {
            try {
              const result = await this.symbolService.lookup({
                query,
                user: { id: userId, settings: { settings: {} } } as any
              });

              if (!result?.items?.length) {
                return {
                  success: false,
                  error: `No results found for "${query}"`
                };
              }

              const searchResult = {
                success: true,
                results: result.items.slice(0, 5).map((item) => ({
                  symbol: item.symbol,
                  name: item.name,
                  currency: item.currency,
                  dataSource: item.dataSource,
                  assetClass: item.assetClass,
                  assetSubClass: item.assetSubClass
                }))
              };
              toolResults.push({ tool: 'market_data', result: searchResult });
              return searchResult;
            } catch (error) {
              return {
                success: false,
                error: `Failed to look up symbol: ${error.message}`
              };
            }
          }
        }),

        transaction_history: tool({
          description:
            'Get the user\'s recent transaction history (buys, sells, dividends, fees). Use this when the user asks about their past trades, activity, transaction patterns, or what they have bought or sold recently.',
          parameters: z.object({
            limit: z
              .number()
              .optional()
              .default(20)
              .describe('Maximum number of transactions to return')
          }),
          execute: async ({ limit }) => {
            try {
              const { activities } = await this.orderService.getOrders({
                filters: [],
                userCurrency: 'USD',
                userId,
                withExcludedAccountsAndActivities: false
              });

              const recentActivities = activities
                .sort(
                  (a, b) =>
                    new Date(b.date).getTime() - new Date(a.date).getTime()
                )
                .slice(0, limit)
                .map((activity) => ({
                  date: activity.date,
                  type: activity.type,
                  symbol: activity.SymbolProfile?.symbol,
                  name: activity.SymbolProfile?.name,
                  quantity: activity.quantity,
                  unitPrice: activity.unitPrice,
                  currency: activity.SymbolProfile?.currency,
                  fee: activity.fee
                }));

              const txResult = {
                success: true,
                transactions: recentActivities,
                totalCount: activities.length
              };
              toolResults.push({
                tool: 'transaction_history',
                result: txResult
              });
              return txResult;
            } catch (error) {
              return {
                success: false,
                error: `Failed to fetch transactions: ${error.message}`
              };
            }
          }
        }),

        risk_assessment: tool({
          description:
            'Analyze portfolio risk including concentration risk, sector/asset class diversification, and individual position sizing. Use this when the user asks about risk, diversification, concentration, whether they are too exposed to a sector, or portfolio safety.',
          parameters: z.object({}),
          execute: async () => {
            try {
              const details = await this.portfolioService.getDetails({
                filters: [],
                impersonationId: undefined,
                userId
              });

              const holdings = Object.values(details.holdings);
              const totalValue = holdings.reduce(
                (sum, h) => sum + (h.valueInBaseCurrency ?? 0),
                0
              );

              if (totalValue === 0) {
                return {
                  success: true,
                  risk: {
                    message: 'No portfolio value found to assess risk.'
                  }
                };
              }

              const positions = holdings
                .map((h) => ({
                  symbol: h.symbol,
                  name: h.name,
                  value: h.valueInBaseCurrency ?? 0,
                  percentage:
                    ((h.valueInBaseCurrency ?? 0) / totalValue) * 100
                }))
                .sort((a, b) => b.percentage - a.percentage);

              const top3Concentration = positions
                .slice(0, 3)
                .reduce((sum, p) => sum + p.percentage, 0);

              const assetClassMap: Record<string, number> = {};
              for (const h of holdings) {
                const cls = h.assetClass || 'UNKNOWN';
                assetClassMap[cls] =
                  (assetClassMap[cls] || 0) + (h.valueInBaseCurrency ?? 0);
              }
              const assetClassBreakdown = Object.entries(assetClassMap).map(
                ([assetClass, value]) => ({
                  assetClass,
                  value,
                  percentage: (value / totalValue) * 100
                })
              );

              const sectorMap: Record<string, number> = {};
              for (const h of holdings) {
                for (const s of (h.sectors as any[]) || []) {
                  const sectorName = s.name || 'Unknown';
                  const sectorValue =
                    (h.valueInBaseCurrency ?? 0) * (s.weight || 0);
                  sectorMap[sectorName] =
                    (sectorMap[sectorName] || 0) + sectorValue;
                }
              }
              const sectorBreakdown = Object.entries(sectorMap)
                .map(([sector, value]) => ({
                  sector,
                  value,
                  percentage: (value / totalValue) * 100
                }))
                .sort((a, b) => b.percentage - a.percentage)
                .slice(0, 10);

              const risks: string[] = [];
              if (positions.length < 5) {
                risks.push(
                  `Low diversification: only ${positions.length} positions`
                );
              }
              if (positions[0]?.percentage > 30) {
                risks.push(
                  `High concentration: ${positions[0].symbol} is ${positions[0].percentage.toFixed(1)}% of portfolio`
                );
              }
              if (top3Concentration > 60) {
                risks.push(
                  `Top 3 positions are ${top3Concentration.toFixed(1)}% of portfolio`
                );
              }
              if (assetClassBreakdown.length === 1) {
                risks.push(
                  'Single asset class - no asset class diversification'
                );
              }

              const riskResult = {
                success: true,
                risk: {
                  totalValue,
                  positionCount: positions.length,
                  top3ConcentrationPct: top3Concentration.toFixed(1),
                  positions: positions.map((p) => ({
                    symbol: p.symbol,
                    name: p.name,
                    percentage: p.percentage.toFixed(2)
                  })),
                  assetClassBreakdown,
                  sectorBreakdown,
                  riskFlags: risks,
                  diversificationScore:
                    risks.length === 0
                      ? 'Good'
                      : risks.length <= 2
                        ? 'Moderate'
                        : 'Poor'
                }
              };
              toolResults.push({
                tool: 'risk_assessment',
                result: riskResult
              });
              return riskResult;
            } catch (error) {
              return {
                success: false,
                error: `Failed to assess risk: ${error.message}`
              };
            }
          }
        }),

        tax_estimate: tool({
          description:
            'Estimate unrealized capital gains and losses for tax planning purposes. Shows cost basis vs current value for each holding and total estimated tax liability. Use this when the user asks about taxes, capital gains, tax-loss harvesting, cost basis, or unrealized gains/losses.',
          parameters: z.object({
            taxRate: z
              .number()
              .optional()
              .default(15)
              .describe(
                'Capital gains tax rate as a percentage (default 15% for long-term US federal)'
              )
          }),
          execute: async ({ taxRate }) => {
            try {
              const [details, { activities }] = await Promise.all([
                this.portfolioService.getDetails({
                  filters: [],
                  impersonationId: undefined,
                  userId
                }),
                this.orderService.getOrders({
                  filters: [],
                  userCurrency: 'USD',
                  userId,
                  withExcludedAccountsAndActivities: false
                })
              ]);

              const holdings = Object.values(details.holdings);

              const costBasisMap: Record<
                string,
                { totalCost: number; totalQty: number; fees: number }
              > = {};
              for (const activity of activities) {
                const symbol = activity.SymbolProfile?.symbol;
                if (!symbol) continue;
                if (!costBasisMap[symbol]) {
                  costBasisMap[symbol] = {
                    totalCost: 0,
                    totalQty: 0,
                    fees: 0
                  };
                }
                if (activity.type === 'BUY') {
                  costBasisMap[symbol].totalCost +=
                    activity.quantity * activity.unitPrice;
                  costBasisMap[symbol].totalQty += activity.quantity;
                  costBasisMap[symbol].fees += activity.fee ?? 0;
                } else if (activity.type === 'SELL') {
                  costBasisMap[symbol].totalCost -=
                    activity.quantity * activity.unitPrice;
                  costBasisMap[symbol].totalQty -= activity.quantity;
                }
              }

              const positionTax = holdings.map((h) => {
                const basis = costBasisMap[h.symbol] || {
                  totalCost: 0,
                  totalQty: 0,
                  fees: 0
                };
                const currentValue = h.valueInBaseCurrency ?? 0;
                const costBasis = basis.totalCost + basis.fees;
                const unrealizedGain = currentValue - costBasis;
                const estimatedTax =
                  unrealizedGain > 0 ? unrealizedGain * (taxRate / 100) : 0;

                return {
                  symbol: h.symbol,
                  name: h.name,
                  quantity: h.quantity,
                  costBasis: costBasis.toFixed(2),
                  currentValue: currentValue.toFixed(2),
                  unrealizedGain: unrealizedGain.toFixed(2),
                  gainPercentage:
                    costBasis > 0
                      ? ((unrealizedGain / costBasis) * 100).toFixed(2)
                      : 'N/A',
                  estimatedTax: estimatedTax.toFixed(2)
                };
              });

              const totalCostBasis = positionTax.reduce(
                (sum, p) => sum + parseFloat(p.costBasis),
                0
              );
              const totalCurrentValue = positionTax.reduce(
                (sum, p) => sum + parseFloat(p.currentValue),
                0
              );
              const totalUnrealizedGain = positionTax.reduce(
                (sum, p) => sum + parseFloat(p.unrealizedGain),
                0
              );
              const totalEstimatedTax = positionTax.reduce(
                (sum, p) => sum + parseFloat(p.estimatedTax),
                0
              );

              const taxResult = {
                success: true,
                taxEstimate: {
                  taxRateUsed: taxRate,
                  positions: positionTax,
                  totals: {
                    costBasis: totalCostBasis.toFixed(2),
                    currentValue: totalCurrentValue.toFixed(2),
                    totalUnrealizedGain: totalUnrealizedGain.toFixed(2),
                    totalEstimatedTax: totalEstimatedTax.toFixed(2),
                    gainPercentage:
                      totalCostBasis > 0
                        ? (
                            (totalUnrealizedGain / totalCostBasis) *
                            100
                          ).toFixed(2)
                        : 'N/A'
                  },
                  disclaimer:
                    'This is a rough estimate for informational purposes only. Actual tax liability depends on holding period, tax brackets, state taxes, and other factors. Consult a tax professional.'
                }
              };
              toolResults.push({ tool: 'tax_estimate', result: taxResult });
              return taxResult;
            } catch (error) {
              return {
                success: false,
                error: `Failed to estimate taxes: ${error.message}`
              };
            }
          }
        })
      },
      maxSteps: 5,
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'ghostfolio-agent',
        metadata: {
          userId,
          conversationId: convId
        }
      }
    });

    // --- Verification Layer ---
    // Cross-check: verify allocation percentages sum to ~100%
    const verification = this.verifyResponse(toolResults, result.text);

    const toolCallsSummary = result.steps.flatMap((step) =>
      step.toolCalls.map((tc) => ({
        tool: tc.toolName,
        args: tc.args
      }))
    );

    // Save assistant response
    await this.prismaService.message.create({
      data: {
        conversationId: convId,
        role: 'assistant',
        content: result.text,
        toolCalls: toolCallsSummary.length > 0 ? toolCallsSummary : undefined
      }
    });

    // Update conversation timestamp
    await this.prismaService.conversation.update({
      where: { id: convId },
      data: { updatedAt: new Date() }
    });

    return {
      conversationId: convId,
      message: result.text,
      toolCalls: toolCallsSummary,
      verification
    };
  }

  // --- Domain-Specific Verification ---
  private verifyResponse(
    toolResults: Array<{ tool: string; result: any }>,
    responseText: string
  ): {
    verified: boolean;
    checks: Array<{ check: string; passed: boolean; detail: string }>;
  } {
    const checks: Array<{
      check: string;
      passed: boolean;
      detail: string;
    }> = [];

    // Check 1: Allocation percentages sum to ~100%
    const portfolioResult = toolResults.find(
      (r) => r.tool === 'portfolio_summary'
    );
    if (portfolioResult?.result?.success && portfolioResult.result.holdings) {
      const totalAllocation = portfolioResult.result.holdings.reduce(
        (sum: number, h: any) =>
          sum + parseFloat(h.allocationInPercentage || '0'),
        0
      );
      const allocationValid =
        totalAllocation > 95 && totalAllocation < 105;
      checks.push({
        check: 'allocation_sum',
        passed: allocationValid,
        detail: `Portfolio allocations sum to ${totalAllocation.toFixed(1)}% (expected ~100%)`
      });
    }

    // Check 2: All holdings have positive market prices
    if (portfolioResult?.result?.success && portfolioResult.result.holdings) {
      const invalidPrices = portfolioResult.result.holdings.filter(
        (h: any) => !h.marketPrice || h.marketPrice <= 0
      );
      checks.push({
        check: 'valid_market_prices',
        passed: invalidPrices.length === 0,
        detail:
          invalidPrices.length === 0
            ? 'All holdings have valid market prices'
            : `${invalidPrices.length} holdings have invalid market prices: ${invalidPrices.map((h: any) => h.symbol).join(', ')}`
      });
    }

    // Check 3: Tax estimate cost basis matches transaction data
    const taxResult = toolResults.find((r) => r.tool === 'tax_estimate');
    if (taxResult?.result?.success && taxResult.result.taxEstimate) {
      const totalCost = parseFloat(
        taxResult.result.taxEstimate.totals.costBasis
      );
      const totalValue = parseFloat(
        taxResult.result.taxEstimate.totals.currentValue
      );
      checks.push({
        check: 'tax_data_consistency',
        passed: totalCost > 0 && totalValue > 0,
        detail: `Cost basis: $${totalCost.toFixed(2)}, Current value: $${totalValue.toFixed(2)}`
      });
    }

    // Check 4: Response doesn't contain hallucinated symbols
    if (portfolioResult?.result?.success && portfolioResult.result.holdings) {
      const knownSymbols = new Set(
        portfolioResult.result.holdings.map((h: any) => h.symbol)
      );
      // Extract potential ticker symbols from response (uppercase 1-5 letter words)
      const mentionedSymbols = responseText.match(/\b[A-Z]{1,5}\b/g) || [];
      const commonWords = new Set([
        'I',
        'A',
        'AN',
        'THE',
        'AND',
        'OR',
        'NOT',
        'IS',
        'IT',
        'IN',
        'ON',
        'TO',
        'FOR',
        'OF',
        'AT',
        'BY',
        'AS',
        'IF',
        'SO',
        'DO',
        'BE',
        'HAS',
        'HAD',
        'WAS',
        'ARE',
        'BUT',
        'ALL',
        'CAN',
        'HER',
        'HIS',
        'ITS',
        'MAY',
        'NEW',
        'NOW',
        'OLD',
        'SEE',
        'WAY',
        'WHO',
        'DID',
        'GET',
        'LET',
        'SAY',
        'SHE',
        'TOO',
        'USE',
        'USD',
        'ETF',
        'USA',
        'FAQ',
        'API',
        'CSV',
        'N',
        'S',
        'P',
        'YOUR',
        'WITH',
        'THAT',
        'THIS',
        'FROM',
        'HAVE',
        'BEEN',
        'WILL',
        'EACH',
        'THAN',
        'THEM',
        'SOME',
        'MOST',
        'VERY',
        'JUST',
        'OVER'
      ]);
      const suspectSymbols = mentionedSymbols.filter(
        (s) => !commonWords.has(s) && !knownSymbols.has(s) && s.length >= 2
      );
      checks.push({
        check: 'no_hallucinated_symbols',
        passed: suspectSymbols.length === 0,
        detail:
          suspectSymbols.length === 0
            ? 'All mentioned symbols are in the portfolio or are known terms'
            : `Potentially unknown symbols mentioned: ${[...new Set(suspectSymbols)].join(', ')}`
      });
    }

    return {
      verified: checks.length === 0 || checks.every((c) => c.passed),
      checks
    };
  }
}
