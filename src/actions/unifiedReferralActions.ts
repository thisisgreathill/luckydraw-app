'use server';

import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  updateDoc,
  increment,
  writeBatch,
  Timestamp,
  runTransaction
} from 'firebase/firestore';
import { UnifiedToken, ReferralStats, ReferralCommission } from '@/types';
import { revalidatePath } from 'next/cache';

// Unified token sistemi ile entegre referral işlemleri

/**
 * Deposit işlemi sonrası referral komisyonu işleme
 */
export async function processDepositReferralAction(
  userId: string,
  depositAmount: number,
  referralCode?: string
) {
  try {
    if (!referralCode) return { success: true };

    // Referral code'u kullanan kullanıcıyı bul
    const referrerQuery = query(
      collection(db, 'users'),
      where('referralCode', '==', referralCode),
      limit(1)
    );
    const referrerSnapshot = await getDocs(referrerQuery);
    
    if (referrerSnapshot.empty) {
      return { success: false, error: 'Geçersiz referral kodu' };
    }

    const referrerId = referrerSnapshot.docs[0].id;
    const referrerData = referrerSnapshot.docs[0].data();

    // Komisyon oranını hesapla (örnek: %5)
    const commissionRate = 0.05;
    const commissionAmount = depositAmount * commissionRate;

    // Transaction ile komisyon işlemi
    await runTransaction(db, async (transaction) => {
      // Unified token oluştur
      const tokenRef = doc(collection(db, 'unifiedTokens'));
      const tokenData: Partial<UnifiedToken> = {
        userId: referrerId,
        type: 'referral_commission',
        amount: commissionAmount,
        status: 'pending',
        metadata: {
          referredUserId: userId,
          originalDepositAmount: depositAmount,
          commissionRate,
          source: 'deposit_referral'
        },
        createdAt: Timestamp.now(),
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)) // 30 gün
      };
      transaction.set(tokenRef, tokenData);

      // Referrer istatistiklerini güncelle
      const referrerRef = doc(db, 'users', referrerId);
      transaction.update(referrerRef, {
        'referralStats.totalCommissions': increment(commissionAmount),
        'referralStats.pendingCommissions': increment(commissionAmount),
        'referralStats.totalReferrals': increment(1),
        'referralStats.lastReferralDate': Timestamp.now()
      });

      // Referred user'ı güncelle
      const userRef = doc(db, 'users', userId);
      transaction.update(userRef, {
        referredBy: referrerId,
        referralProcessedAt: Timestamp.now()
      });
    });

    revalidatePath('/dashboard/referrals');
    return { success: true, commissionAmount };

  } catch (error) {
    console.error('Referral processing error:', error);
    return { success: false, error: 'Referral işlemi başarısız' };
  }
}

/**
 * Kullanıcının referral istatistiklerini getir
 */
export async function getUserReferralStatsAction(userId: string): Promise<ReferralStats | null> {
  try {
    const userDoc = await getDoc(doc(db, 'users', userId));
    if (!userDoc.exists()) return null;

    const userData = userDoc.data();
    return userData.referralStats || {
      totalReferrals: 0,
      totalCommissions: 0,
      pendingCommissions: 0,
      approvedCommissions: 0,
      lastReferralDate: null
    };
  } catch (error) {
    console.error('Get referral stats error:', error);
    return null;
  }
}

/**
 * Kullanıcının referral komisyon tokenlarını getir
 */
export async function getUserReferralCommissionTokensAction(userId: string) {
  try {
    const tokensQuery = query(
      collection(db, 'unifiedTokens'),
      where('userId', '==', userId),
      where('type', '==', 'referral_commission'),
      orderBy('createdAt', 'desc'),
      limit(50)
    );

    const tokensSnapshot = await getDocs(tokensQuery);
    const tokens = tokensSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return { success: true, tokens };
  } catch (error) {
    console.error('Get referral tokens error:', error);
    return { success: false, error: 'Komisyon tokenları alınamadı' };
  }
}

/**
 * Referral komisyonunu onayla ve bakiyeye ekle
 */
export async function approveReferralCommissionAction(
  tokenId: string,
  adminUserId: string
) {
  try {
    const tokenRef = doc(db, 'unifiedTokens', tokenId);
    const tokenDoc = await getDoc(tokenRef);
    
    if (!tokenDoc.exists()) {
      return { success: false, error: 'Token bulunamadı' };
    }

    const tokenData = tokenDoc.data() as UnifiedToken;
    
    if (tokenData.status !== 'pending') {
      return { success: false, error: 'Token zaten işlenmiş' };
    }

    await runTransaction(db, async (transaction) => {
      // Token'ı onayla
      transaction.update(tokenRef, {
        status: 'approved',
        approvedAt: Timestamp.now(),
        approvedBy: adminUserId
      });

      // Kullanıcı bakiyesini güncelle
      const userRef = doc(db, 'users', tokenData.userId);
      transaction.update(userRef, {
        balance: increment(tokenData.amount),
        'referralStats.approvedCommissions': increment(tokenData.amount),
        'referralStats.pendingCommissions': increment(-tokenData.amount)
      });
    });

    revalidatePath('/admin/referrals');
    revalidatePath('/dashboard/referrals');
    return { success: true };

  } catch (error) {
    console.error('Approve referral commission error:', error);
    return { success: false, error: 'Komisyon onaylanamadı' };
  }
}

/**
 * Kullanıcının referral zincirini getir
 */
export async function getUserReferralChainAction(userId: string) {
  try {
    // Kullanıcının referral ettiği kişileri bul
    const referredUsersQuery = query(
      collection(db, 'users'),
      where('referredBy', '==', userId),
      orderBy('referralProcessedAt', 'desc'),
      limit(100)
    );

    const referredSnapshot = await getDocs(referredUsersQuery);
    const referredUsers = referredSnapshot.docs.map(doc => ({
      id: doc.id,
      email: doc.data().email,
      displayName: doc.data().displayName,
      referralProcessedAt: doc.data().referralProcessedAt,
      totalDeposits: doc.data().totalDeposits || 0
    }));

    return { success: true, referredUsers };
  } catch (error) {
    console.error('Get referral chain error:', error);
    return { success: false, error: 'Referral zinciri alınamadı' };
  }
}

/**
 * Bekleyen referral komisyonlarını getir (Admin)
 */
export async function getPendingReferralCommissionsAction() {
  try {
    const pendingQuery = query(
      collection(db, 'unifiedTokens'),
      where('type', '==', 'referral_commission'),
      where('status', '==', 'pending'),
      orderBy('createdAt', 'desc'),
      limit(100)
    );

    const pendingSnapshot = await getDocs(pendingQuery);
    const pendingCommissions = [];

    for (const doc of pendingSnapshot.docs) {
      const tokenData = doc.data();
      
      // Kullanıcı bilgilerini al
      const userDoc = await getDoc(doc(db, 'users', tokenData.userId));
      const userData = userDoc.exists() ? userDoc.data() : null;

      pendingCommissions.push({
        id: doc.id,
        ...tokenData,
        user: userData ? {
          email: userData.email,
          displayName: userData.displayName
        } : null
      });
    }

    return { success: true, commissions: pendingCommissions };
  } catch (error) {
    console.error('Get pending commissions error:', error);
    return { success: false, error: 'Bekleyen komisyonlar alınamadı' };
  }
}

/**
 * Referral performans analizi
 */
export async function analyzeReferralPerformanceAction(userId: string) {
  try {
    // Son 30 günlük referral aktivitesi
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const recentReferralsQuery = query(
      collection(db, 'users'),
      where('referredBy', '==', userId),
      where('referralProcessedAt', '>=', Timestamp.fromDate(thirtyDaysAgo))
    );

    const recentSnapshot = await getDocs(recentReferralsQuery);
    const recentReferrals = recentSnapshot.docs.length;

    // Toplam komisyon tokenları
    const commissionsQuery = query(
      collection(db, 'unifiedTokens'),
      where('userId', '==', userId),
      where('type', '==', 'referral_commission')
    );

    const commissionsSnapshot = await getDocs(commissionsQuery);
    const totalCommissionTokens = commissionsSnapshot.docs.length;
    const totalCommissionAmount = commissionsSnapshot.docs.reduce(
      (sum, doc) => sum + (doc.data().amount || 0), 0
    );

    // Onaylanmış komisyonlar
    const approvedCommissions = commissionsSnapshot.docs.filter(
      doc => doc.data().status === 'approved'
    ).length;

    const analysis = {
      recentReferrals,
      totalCommissionTokens,
      totalCommissionAmount,
      approvedCommissions,
      approvalRate: totalCommissionTokens > 0 ? (approvedCommissions / totalCommissionTokens) * 100 : 0,
      averageCommissionAmount: totalCommissionTokens > 0 ? totalCommissionAmount / totalCommissionTokens : 0
    };

    return { success: true, analysis };
  } catch (error) {
    console.error('Referral analysis error:', error);
    return { success: false, error: 'Analiz yapılamadı' };
  }
}