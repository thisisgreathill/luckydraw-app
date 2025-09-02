'use server';

import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
  runTransaction,
  writeBatch
} from 'firebase/firestore';
import { UnifiedToken, TokenType, TokenStatus } from '@/types';
import { revalidatePath } from 'next/cache';

// Birleşik token sistemi - tüm token türlerini yönetir

/**
 * Yeni unified token oluştur
 */
export async function createUnifiedTokenAction(
  userId: string,
  type: TokenType,
  amount: number,
  metadata?: Record<string, any>,
  expiresInDays?: number
) {
  try {
    const tokenData: Partial<UnifiedToken> = {
      userId,
      type,
      amount,
      status: 'pending' as TokenStatus,
      metadata: metadata || {},
      createdAt: Timestamp.now(),
      expiresAt: expiresInDays 
        ? Timestamp.fromDate(new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000))
        : undefined
    };

    const docRef = await addDoc(collection(db, 'unifiedTokens'), tokenData);
    
    revalidatePath('/admin/tokens');
    revalidatePath('/dashboard');
    
    return { success: true, tokenId: docRef.id };
  } catch (error) {
    console.error('Create unified token error:', error);
    return { success: false, error: 'Token oluşturulamadı' };
  }
}

/**
 * Unified token güncelle
 */
export async function updateUnifiedTokenAction(
  tokenId: string,
  updates: Partial<UnifiedToken>
) {
  try {
    const tokenRef = doc(db, 'unifiedTokens', tokenId);
    
    // updatedAt alanını ekle
    const updateData = {
      ...updates,
      updatedAt: Timestamp.now()
    };

    await updateDoc(tokenRef, updateData);
    
    revalidatePath('/admin/tokens');
    revalidatePath('/dashboard');
    
    return { success: true };
  } catch (error) {
    console.error('Update unified token error:', error);
    return { success: false, error: 'Token güncellenemedi' };
  }
}

/**
 * Unified token getir
 */
export async function getUnifiedTokenAction(tokenId: string) {
  try {
    const tokenDoc = await getDoc(doc(db, 'unifiedTokens', tokenId));
    
    if (!tokenDoc.exists()) {
      return { success: false, error: 'Token bulunamadı' };
    }

    const tokenData = { id: tokenDoc.id, ...tokenDoc.data() };
    return { success: true, token: tokenData };
  } catch (error) {
    console.error('Get unified token error:', error);
    return { success: false, error: 'Token alınamadı' };
  }
}

/**
 * Kullanıcının unified tokenlarını getir
 */
export async function getUserUnifiedTokensAction(
  userId: string,
  tokenType?: TokenType,
  status?: TokenStatus,
  limitCount: number = 50
) {
  try {
    let q = query(
      collection(db, 'unifiedTokens'),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc'),
      limit(limitCount)
    );

    // Opsiyonel filtreler
    if (tokenType) {
      q = query(
        collection(db, 'unifiedTokens'),
        where('userId', '==', userId),
        where('type', '==', tokenType),
        orderBy('createdAt', 'desc'),
        limit(limitCount)
      );
    }

    if (status) {
      q = query(
        collection(db, 'unifiedTokens'),
        where('userId', '==', userId),
        where('status', '==', status),
        orderBy('createdAt', 'desc'),
        limit(limitCount)
      );
    }

    const tokensSnapshot = await getDocs(q);
    const tokens = tokensSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return { success: true, tokens };
  } catch (error) {
    console.error('Get user unified tokens error:', error);
    return { success: false, error: 'Tokenlar alınamadı' };
  }
}

/**
 * Token onayla ve işle
 */
export async function approveTokenAction(
  tokenId: string,
  adminUserId: string,
  notes?: string
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
        approvedBy: adminUserId,
        adminNotes: notes || ''
      });

      // Token türüne göre işlem yap
      const userRef = doc(db, 'users', tokenData.userId);
      
      switch (tokenData.type) {
        case 'deposit':
        case 'bonus':
        case 'referral_commission':
        case 'cashback':
          // Bakiyeye ekle
          transaction.update(userRef, {
            balance: increment(tokenData.amount),
            [`${tokenData.type}Total`]: increment(tokenData.amount)
          });
          break;
          
        case 'withdrawal':
          // Bakiyeden düş
          transaction.update(userRef, {
            balance: increment(-tokenData.amount),
            withdrawalTotal: increment(tokenData.amount)
          });
          break;
          
        case 'raffle_entry':
          // Çekiliş katılımı - özel işlem gerekebilir
          break;
      }
    });

    revalidatePath('/admin/tokens');
    revalidatePath('/dashboard');
    
    return { success: true };
  } catch (error) {
    console.error('Approve token error:', error);
    return { success: false, error: 'Token onaylanamadı' };
  }
}

/**
 * Token reddet
 */
export async function rejectTokenAction(
  tokenId: string,
  adminUserId: string,
  reason: string
) {
  try {
    const tokenRef = doc(db, 'unifiedTokens', tokenId);
    
    await updateDoc(tokenRef, {
      status: 'rejected',
      rejectedAt: Timestamp.now(),
      rejectedBy: adminUserId,
      rejectionReason: reason
    });

    revalidatePath('/admin/tokens');
    revalidatePath('/dashboard');
    
    return { success: true };
  } catch (error) {
    console.error('Reject token error:', error);
    return { success: false, error: 'Token reddedilemedi' };
  }
}

/**
 * Süresi dolmuş tokenları temizle
 */
export async function cleanupExpiredTokensAction() {
  try {
    const now = Timestamp.now();
    const expiredQuery = query(
      collection(db, 'unifiedTokens'),
      where('expiresAt', '<=', now),
      where('status', '==', 'pending'),
      limit(100)
    );

    const expiredSnapshot = await getDocs(expiredQuery);
    
    if (expiredSnapshot.empty) {
      return { success: true, deletedCount: 0 };
    }

    const batch = writeBatch(db);
    
    expiredSnapshot.docs.forEach(doc => {
      batch.update(doc.ref, {
        status: 'expired',
        expiredAt: now
      });
    });

    await batch.commit();
    
    revalidatePath('/admin/tokens');
    
    return { success: true, deletedCount: expiredSnapshot.docs.length };
  } catch (error) {
    console.error('Cleanup expired tokens error:', error);
    return { success: false, error: 'Süresi dolmuş tokenlar temizlenemedi' };
  }
}

/**
 * Token istatistikleri
 */
export async function getTokenStatisticsAction() {
  try {
    // Toplam token sayıları
    const allTokensSnapshot = await getDocs(collection(db, 'unifiedTokens'));
    const allTokens = allTokensSnapshot.docs.map(doc => doc.data());

    const stats = {
      total: allTokens.length,
      pending: allTokens.filter(t => t.status === 'pending').length,
      approved: allTokens.filter(t => t.status === 'approved').length,
      rejected: allTokens.filter(t => t.status === 'rejected').length,
      expired: allTokens.filter(t => t.status === 'expired').length,
      
      byType: {
        deposit: allTokens.filter(t => t.type === 'deposit').length,
        withdrawal: allTokens.filter(t => t.type === 'withdrawal').length,
        bonus: allTokens.filter(t => t.type === 'bonus').length,
        referral_commission: allTokens.filter(t => t.type === 'referral_commission').length,
        cashback: allTokens.filter(t => t.type === 'cashback').length,
        raffle_entry: allTokens.filter(t => t.type === 'raffle_entry').length
      },
      
      totalAmounts: {
        pending: allTokens.filter(t => t.status === 'pending').reduce((sum, t) => sum + (t.amount || 0), 0),
        approved: allTokens.filter(t => t.status === 'approved').reduce((sum, t) => sum + (t.amount || 0), 0),
        rejected: allTokens.filter(t => t.status === 'rejected').reduce((sum, t) => sum + (t.amount || 0), 0)
      }
    };

    return { success: true, stats };
  } catch (error) {
    console.error('Get token statistics error:', error);
    return { success: false, error: 'İstatistikler alınamadı' };
  }
}

/**
 * Eski transaction'ları unified token'a migrate et
 */
export async function migrateTransactionToTokenAction(
  transactionId: string,
  adminUserId: string
) {
  try {
    // Eski transaction'ı al
    const transactionDoc = await getDoc(doc(db, 'transactions', transactionId));
    
    if (!transactionDoc.exists()) {
      return { success: false, error: 'Transaction bulunamadı' };
    }

    const transactionData = transactionDoc.data();
    
    // Unified token oluştur
    const tokenData: Partial<UnifiedToken> = {
      userId: transactionData.userId,
      type: transactionData.type as TokenType,
      amount: transactionData.amount,
      status: transactionData.status as TokenStatus,
      metadata: {
        migratedFrom: 'transaction',
        originalTransactionId: transactionId,
        migratedBy: adminUserId,
        originalData: transactionData
      },
      createdAt: transactionData.createdAt || Timestamp.now(),
      approvedAt: transactionData.approvedAt,
      approvedBy: transactionData.approvedBy
    };

    const tokenRef = await addDoc(collection(db, 'unifiedTokens'), tokenData);
    
    // Eski transaction'ı işaretle
    await updateDoc(doc(db, 'transactions', transactionId), {
      migratedToToken: tokenRef.id,
      migratedAt: Timestamp.now(),
      migratedBy: adminUserId
    });

    revalidatePath('/admin/tokens');
    revalidatePath('/admin/transactions');
    
    return { success: true, tokenId: tokenRef.id };
  } catch (error) {
    console.error('Migrate transaction error:', error);
    return { success: false, error: 'Migration başarısız' };
  }
}